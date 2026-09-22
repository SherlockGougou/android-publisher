/**
 * VIVO 应用商店上传
 *
 * 完整流程（3 步）：
 * 1. 查询应用详情（拿 onlineType, versionCode 等）
 * 2. 上传 APK（multipart POST）
 * 3. 同步更新（提交审核）
 *
 * 签名算法：所有请求参数（含公共参数 + 业务参数）字典序排序后，
 * 拼接 k=v& 字符串，HmacSHA256(str, accessSecret)，结果 hex
 */

import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { hmacSha256, md5File } from './utils/crypto.js';
import { retry } from './utils/retry.js';
import { logHttpRequest, logHttpResponse } from './utils/http-debug.js';
import { createChannelLogger } from './utils/channel-logger.js';

const BASE_URL = 'https://developer-api.vivo.com.cn/router/rest';
const TIMEOUT = 120000;

/**
 * @param {Record<string,string>} params   {access_key, access_secret}
 * @param {string} apkPath
 * @param {string} packageName
 * @param {string} updateDesc
 * @param {(progress:number, message:string)=>void} onProgress
 */
export async function uploadVivo(params, apkPath, packageName, updateDesc, onProgress) {
  const log = createChannelLogger('VIVO');
  const { access_key, access_secret } = params;
  log.info('上传流程开始', { apkPath, packageName, updateDescLength: updateDesc?.length });

  const s1 = log.step('查询应用信息', { packageName });
  onProgress(10, '正在查询应用信息...');
  let appInfo;
  try {
    appInfo = await queryAppDetails(access_key, access_secret, packageName);
    s1.end({ onlineType: appInfo?.onlineType, status: appInfo?.status });
  } catch (e) { s1.fail(e); throw e; }

  const fileMd5 = await md5File(apkPath);

  const s2 = log.step('上传 APK', { packageName, fileMd5, fileName: path.basename(apkPath) });
  onProgress(30, '正在上传 APK...');
  let uploadResult;
  try {
    uploadResult = await uploadApk(access_key, access_secret, apkPath, packageName, fileMd5);
    s2.end({ serialnumber: uploadResult?.serialnumber, versionCode: uploadResult?.versionCode });
  } catch (e) { s2.fail(e); throw e; }

  const s3 = log.step('同步更新', { packageName, versionCode: uploadResult?.versionCode });
  onProgress(80, '正在提交更新...');
  try {
    await syncUpdate(access_key, access_secret, packageName, appInfo, uploadResult, fileMd5, updateDesc);
    s3.end();
  } catch (e) { s3.fail(e); throw e; }

  log.info('上传流程完成', { packageName });
  onProgress(100, '提交成功');
}

async function queryAppDetails(accessKey, accessSecret, packageName) {
  const params = buildCommonParams(accessKey, 'app.query.details');
  params.packageName = packageName;
  params.sign = computeSign(params, accessSecret);

  const qs = new URLSearchParams(params).toString();
  // 查询为幂等操作，网络抖动/5xx 时重试
  const data = await retry(() => getJson(`${BASE_URL}?${qs}`));
  checkCode(data, '查询应用详情');
  return data.data;
}

async function uploadApk(accessKey, accessSecret, apkPath, packageName, fileMd5) {
  const commonParams = buildCommonParams(accessKey, 'app.upload.apk.app');
  commonParams.packageName = packageName;
  commonParams.fileMd5 = fileMd5;
  commonParams.sign = computeSign(commonParams, accessSecret);

  const qs = new URLSearchParams(commonParams).toString();
  const targetUrl = `${BASE_URL}?${qs}`;

  const form = new FormData();
  form.append('file', fs.createReadStream(apkPath), { filename: path.basename(apkPath) });

  const data = await postForm(targetUrl, form);
  checkCode(data, '上传 APK');
  return data.data; // {packageName, serialnumber, versionCode, versionName, fileMd5}
}

async function syncUpdate(accessKey, accessSecret, packageName, appInfo, uploadResult, fileMd5, updateDesc) {
  const params = buildCommonParams(accessKey, 'app.sync.update.app');
  params.packageName = packageName;
  params.versionCode = String(uploadResult.versionCode);
  params.apk = uploadResult.serialnumber;
  params.fileMd5 = fileMd5;
  params.onlineType = String(appInfo?.onlineType ?? 1);
  params.updateDesc = updateDesc;
  params.sign = computeSign(params, accessSecret);

  const qs = new URLSearchParams(params).toString();
  const data = await getJson(`${BASE_URL}?${qs}`);
  checkCode(data, '同步更新');
}

// ── 签名工具 ────────────────────────────────────────────────────────────────

function buildCommonParams(accessKey, method) {
  return {
    access_key: accessKey,
    timestamp: Date.now().toString(),
    method,
    v: '1.0',
    sign_method: 'HMAC-SHA256',
    format: 'json',
    target_app_key: 'developer',
  };
}

function computeSign(params, secret) {
  const sorted = Object.keys(params).sort();
  const str = sorted.map((k) => `${k}=${params[k]}`).join('&');
  return hmacSha256(secret, str);
}

function checkCode(data, action) {
  if (Number(data.code) !== 0 || Number(data.subCode) !== 0) {
    throw new Error(`VIVO ${action} 失败: code=${data.code}, subCode=${data.subCode}, msg=${data.msg || ''}`);
  }
}

// ── HTTP 工具 ───────────────────────────────────────────────────────────────

function getJson(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      timeout: TIMEOUT,
    };
    logHttpRequest('VIVO', { method: 'GET', url: urlStr, headers: options.headers, body: null });
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf-8');
          logHttpResponse('VIVO', {
            method: 'GET',
            url: urlStr,
            statusCode: res.statusCode,
            headers: res.headers,
            body: text,
          });
          if (res.statusCode >= 400) {
            reject(new Error(`VIVO GET ${urlStr} 失败 HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          resolve(JSON.parse(text));
        }
        catch (e) { reject(new Error(`VIVO 响应解析失败: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

function postForm(urlStr, form) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: form.getHeaders(),
      timeout: TIMEOUT,
    };
    logHttpRequest('VIVO', {
      method: 'POST',
      url: urlStr,
      headers: options.headers,
      body: { type: 'multipart/form-data', fields: ['file'] },
    });
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf-8');
          logHttpResponse('VIVO', {
            method: 'POST',
            url: urlStr,
            statusCode: res.statusCode,
            headers: res.headers,
            body: text,
          });
          if (res.statusCode >= 400) {
            reject(new Error(`VIVO POST ${urlStr} 失败 HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          resolve(JSON.parse(text));
        }
        catch { reject(new Error('VIVO 上传响应解析失败')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('VIVO 上传超时')); });
    form.pipe(req);
  });
}

/**
 * 查询 VIVO 应用审核状态
 * @param {Record<string,string>} params {access_key, access_secret}
 * @param {string} packageName
 * @returns {{ state: string, versionCode: number, versionName: string }}
 */
export async function queryVivo(params, packageName) {
  const log = createChannelLogger('VIVO');
  const { access_key, access_secret } = params;
  log.info('查询审核状态开始', { packageName });

  const s1 = log.step('查询应用信息', { packageName });
  const info = await queryAppDetails(access_key, access_secret, packageName);
  s1.end({ status: info.status, versionCode: info.versionCode, versionName: info.versionName });

  // status: 2=待审核, 3=审核通过(已上线), 4=审核不通过
  let state;
  if (info.status === 3) state = 'Online';
  else if (info.status === 2) state = 'UnderReview';
  else if (info.status === 4) state = 'Rejected';
  else state = 'Unknown';
  log.info('查询审核状态完成', { state, status: info.status, versionCode: info.versionCode, versionName: info.versionName });
  return { state, versionCode: info.versionCode ?? 0, versionName: info.versionName ?? '' };
}
