/**
 * 腾讯应用宝上传
 *
 * 完整流程（3 步）：
 * 1. 获取文件上传信息（pre_sign_url + serial_number）
 * 2. PUT APK 到预签名 URL
 * 3. 更新应用（提交审核）
 *
 * 签名算法：所有表单参数字典序排序，拼接 k=v& 后 HmacSHA256(str, accessSecret)，小写 hex
 * 注意：updateDesc 需去除 emoji（代理对字符）
 */

import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { URL } from 'url';
import { hmacSha256, md5File } from './utils/crypto.js';
import { apkHas32BitLibs } from './utils/apk.js';
import { retry } from './utils/retry.js';
import { logHttpRequest, logHttpResponse } from './utils/http-debug.js';
import { createChannelLogger } from './utils/channel-logger.js';

const BASE_URL = 'https://p.open.qq.com/open_file/developer_api';
const TIMEOUT = 120000;

/**
 * @param {Record<string,string>} params   {user_id, access_secret, app_id}
 * @param {string} apkPath
 * @param {string} packageName
 * @param {string} updateDesc
 * @param {(progress:number, message:string)=>void} onProgress
 */
export async function uploadTencent(params, apkPath, packageName, updateDesc, onProgress) {
  const log = createChannelLogger('腾讯应用宝');
  const { user_id, access_secret, app_id } = params;
  const fileName = path.basename(apkPath);
  const cleanDesc = stripEmojis(updateDesc);
  log.info('上传流程开始', { apkPath, packageName, fileName, updateDescLength: updateDesc?.length, cleanDescLength: cleanDesc?.length });

  const s1 = log.step('获取上传信息', { packageName, app_id, fileName });
  onProgress(10, '正在获取上传信息...');
  let uploadInfo;
  try {
    uploadInfo = await getFileUploadInfo(user_id, access_secret, app_id, packageName, fileName);
    s1.end({ serial_number: uploadInfo.serial_number, hasPreSignUrl: !!uploadInfo.pre_sign_url });
  } catch (e) { s1.fail(e); throw e; }

  const apkMd5 = await md5File(apkPath);
  const is32Bit = await apkHas32BitLibs(apkPath);

  const s2 = log.step('上传 APK', { fileName, apkMd5, is32Bit });
  onProgress(30, '正在上传 APK...');
  try {
    await putApkToPresignUrl(uploadInfo.pre_sign_url, apkPath);
    s2.end();
  } catch (e) { s2.fail(e); throw e; }

  const s3 = log.step('提交更新', { packageName, serial_number: uploadInfo.serial_number, is32Bit });
  onProgress(80, '正在提交更新...');
  try {
    await updateApp(user_id, access_secret, app_id, packageName, uploadInfo.serial_number, apkMd5, cleanDesc, is32Bit);
    s3.end();
  } catch (e) { s3.fail(e); throw e; }

  log.info('上传流程完成', { packageName });
  onProgress(100, '提交成功');
}

async function getFileUploadInfo(userId, accessSecret, appId, pkgName, fileName) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params = { user_id: userId, timestamp, pkg_name: pkgName, app_id: appId, file_type: 'apk', file_name: fileName };
  params.sign = computeSign(params, accessSecret);

  const body = new URLSearchParams(params).toString();
  // 获取上传信息为幂等操作，网络抖动/5xx 时重试
  const data = await retry(() => postFormEncoded(`${BASE_URL}/get_file_upload_info`, body));
  if (data.ret !== 0) throw new Error(`应用宝获取上传信息失败: ${data.msg || JSON.stringify(data)}`);
  return data; // {ret, pre_sign_url, serial_number}
}

async function putApkToPresignUrl(preSignUrl, apkPath) {
  const fileSize = fs.statSync(apkPath).size;
  await new Promise((resolve, reject) => {
    const url = new URL(preSignUrl);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'PUT',
      headers: { 'Content-Length': fileSize },
      timeout: TIMEOUT,
    };
    logHttpRequest('腾讯应用宝', {
      method: 'PUT',
      url: preSignUrl,
      headers: options.headers,
      body: { file: path.basename(apkPath), size: fileSize },
    });
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        logHttpResponse('腾讯应用宝', {
          method: 'PUT',
          url: preSignUrl,
          statusCode: res.statusCode,
          headers: res.headers,
          body: text,
        });
        if (res.statusCode >= 400) {
          reject(new Error(`应用宝 PUT 上传失败 HTTP ${res.statusCode}`));
        } else {
          resolve();
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('应用宝上传超时')); });
    const stream = fs.createReadStream(apkPath);
    stream.pipe(req);
    stream.on('error', reject);
  });
}

async function updateApp(userId, accessSecret, appId, pkgName, serialNumber, apkMd5, updateDesc, is32Bit) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params = is32Bit
    ? {
        user_id: userId,
        timestamp,
        pkg_name: pkgName,
        app_id: appId,
        deploy_type: '1',
        apk32_flag: '1',
        apk32_file_serial_number: serialNumber,
        apk32_file_md5: apkMd5,
        feature: updateDesc,
      }
    : {
        user_id: userId,
        timestamp,
        pkg_name: pkgName,
        app_id: appId,
        deploy_type: '1',
        apk64_flag: '1',
        apk64_file_serial_number: serialNumber,
        apk64_file_md5: apkMd5,
        feature: updateDesc,
      };
  params.sign = computeSign(params, accessSecret);

  const body = new URLSearchParams(params).toString();
  const data = await postFormEncoded(`${BASE_URL}/update_app`, body);
  if (data.ret !== 0) throw new Error(`应用宝提交失败: ${data.msg || JSON.stringify(data)}`);
}

// ── 工具 ────────────────────────────────────────────────────────────────────

function computeSign(params, secret) {
  const sorted = Object.keys(params)
    .filter((k) => k !== 'sign')
    .sort();
  const str = sorted.map((k) => `${k}=${params[k]}`).join('&');
  return hmacSha256(secret, str);
}

/**
 * 去除 emoji（代理对/高代码点字符）
 */
function stripEmojis(str) {
  return str.replace(
    /[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}]/gu,
    ''
  ).trim();
}

function postFormEncoded(urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const bodyBuf = Buffer.from(body, 'utf-8');
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': bodyBuf.length,
      },
      timeout: TIMEOUT,
    };
    logHttpRequest('腾讯应用宝', { method: 'POST', url: urlStr, headers: options.headers, body });
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf-8');
          logHttpResponse('腾讯应用宝', {
            method: 'POST',
            url: urlStr,
            statusCode: res.statusCode,
            headers: res.headers,
            body: text,
          });
          if (res.statusCode >= 400) {
            reject(new Error(`应用宝 POST ${urlStr} 失败 HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          resolve(JSON.parse(text));
        }
        catch (e) { reject(new Error(`应用宝响应解析失败: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('应用宝请求超时')); });
    req.write(bodyBuf);
    req.end();
  });
}

/**
 * 查询腾讯应用宝审核状态
 * @param {Record<string,string>} params {user_id, access_secret, app_id}
 * @param {string} packageName
 * @returns {{ state: string, versionCode: number, versionName: string }}
 */
export async function queryTencent(params, packageName) {
  const log = createChannelLogger('腾讯应用宝');
  const { user_id, access_secret, app_id } = params;
  log.info('查询审核状态开始', { packageName, app_id });

  const s1 = log.step('查询应用更新状态', { packageName, app_id });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const reqParams = { user_id, timestamp, pkg_name: packageName, app_id };
  reqParams.sign = computeSign(reqParams, access_secret);
  const data = await postFormEncoded(`${BASE_URL}/query_app_update_status`, new URLSearchParams(reqParams).toString());
  if (data.ret !== 0) throw new Error(`应用宝查询失败: ${data.msg || JSON.stringify(data)}`);
  s1.end({ audit_status: data.audit_status });

  // audit_status: 1=审核中, 2=被拒绝, 3=已上线, 8=开发者撤销
  let state;
  const auditStatus = Number(data.audit_status);
  if (auditStatus === 3) state = 'Online';
  else if (auditStatus === 1) state = 'UnderReview';
  else if (auditStatus === 2) state = 'Rejected';
  else state = 'Unknown';
  log.info('查询审核状态完成', { state, auditStatus });
  return { state, versionCode: 0, versionName: '' };
}
