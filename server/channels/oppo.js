/**
 * OPPO 应用商店上传
 *
 * 完整流程（5 步）：
 * 1. 获取 access_token（OAuth2）
 * 2. 获取应用信息（拿分类/图标等字段，提交时需要完整回传）
 * 3. 获取上传 URL
 * 4. 上传 APK（multipart）
 * 5. 更新应用信息（提交审核）
 *
 * 签名算法：所有请求参数字典序排序，拼接 k=v& 后 HmacSHA256(str, clientSecret)
 */

import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { hmacSha256 } from './utils/crypto.js';
import { readApkManifest } from './utils/apk.js';
import { retry } from './utils/retry.js';
import { getCachedToken, invalidateToken } from './utils/token-cache.js';
import { logHttpRequest, logHttpResponse } from './utils/http-debug.js';
import { createChannelLogger } from './utils/channel-logger.js';

const BASE_URL = 'https://oop-openapi-cn.heytapmobi.com';
const TIMEOUT = 120000;

/**
 * @param {Record<string,string>} params   {client_id, client_secret}
 * @param {string} apkPath
 * @param {string} packageName
 * @param {string} updateDesc
 * @param {(progress:number, message:string)=>void} onProgress
 */
export async function uploadOppo(params, apkPath, packageName, updateDesc, onProgress) {
  const log = createChannelLogger('OPPO');
  const { client_id, client_secret } = params;
  log.info('上传流程开始', { apkPath, packageName, updateDescLength: updateDesc?.length });

  const s1 = log.step('获取访问令牌');
  onProgress(5, '正在获取访问令牌...');
  let accessToken;
  try {
    accessToken = await getAccessToken(client_id, client_secret);
    s1.end();
  } catch (e) { s1.fail(e); throw e; }

  const s2 = log.step('获取应用信息', { packageName });
  onProgress(20, '正在获取应用信息...');
  let appInfo, apkInfo;
  try {
    appInfo = await getAppInfo(client_id, client_secret, accessToken, packageName);
    apkInfo = await readApkManifest(apkPath);
    s2.end({ app_name: appInfo?.app_name, versionCode: apkInfo?.versionCode });
  } catch (e) { s2.fail(e); throw e; }

  const s3 = log.step('获取上传地址');
  onProgress(35, '正在获取上传地址...');
  let uploadUrl;
  try {
    uploadUrl = await getUploadUrl(client_id, client_secret, accessToken);
    s3.end({ upload_url: uploadUrl?.upload_url?.substring(0, 80) + '...' });
  } catch (e) { s3.fail(e); throw e; }

  const s4 = log.step('上传 APK', { fileName: path.basename(apkPath) });
  onProgress(50, '正在上传 APK...');
  let apkResult;
  try {
    apkResult = await uploadApk(client_id, client_secret, accessToken, uploadUrl, apkPath);
    s4.end({ url: apkResult?.url?.substring(0, 80) + '...', md5: apkResult?.md5 });
  } catch (e) { s4.fail(e); throw e; }

  const s5 = log.step('提交应用信息', { packageName });
  onProgress(80, '正在提交应用信息...');
  try {
    await updateApp(client_id, client_secret, accessToken, packageName, apkInfo, appInfo, apkResult, updateDesc);
    s5.end();
  } catch (e) { s5.fail(e); throw e; }

  log.info('上传流程完成', { packageName });
  onProgress(100, '提交成功');
}

async function getAccessToken(clientId, clientSecret) {
  const cacheKey = `oppo:${clientId}`;
  return retry(() => getCachedToken(cacheKey, async () => {
    const url = `${BASE_URL}/developer/v1/token?client_id=${clientId}&client_secret=${encodeURIComponent(clientSecret)}`;
    const data = await getJson(url);
    if (data.errno !== 0) throw new Error(`OPPO 获取 token 失败: ${getOppoErrorMessage(data)}`);
    return data.data.access_token;
  }));
}

async function getAppInfo(clientId, clientSecret, accessToken, pkgName) {
  const params = buildSignParams(clientId, clientSecret, accessToken, { pkg_name: pkgName });
  const qs = new URLSearchParams(params).toString();
  // 查询为幂等操作，网络抖动/5xx 时重试
  return retry(async () => {
    try {
      const data = await getJson(`${BASE_URL}/resource/v1/app/info?${qs}`);
      if (data.errno !== 0) throw new Error(`OPPO 获取应用信息失败: ${getOppoErrorMessage(data)}`);
      return data.data;
    } catch (err) {
      // token 失效时清除缓存，下次任务自动重新获取
      if (/HTTP 401/.test(err.message)) invalidateToken(`oppo:${clientId}`);
      throw err;
    }
  });
}

async function getUploadUrl(clientId, clientSecret, accessToken) {
  const params = buildSignParams(clientId, clientSecret, accessToken);
  const qs = new URLSearchParams(params).toString();
  // 获取上传地址为幂等操作，网络抖动/5xx 时重试
  return retry(async () => {
    try {
      const data = await getJson(`${BASE_URL}/resource/v1/upload/get-upload-url?${qs}`);
      if (data.errno !== 0) throw new Error(`OPPO 获取上传地址失败: ${getOppoErrorMessage(data)}`);
      return data.data;
    } catch (err) {
      if (/HTTP 401/.test(err.message)) invalidateToken(`oppo:${clientId}`);
      throw err;
    }
  });
}

async function uploadApk(clientId, clientSecret, accessToken, uploadUrlInfo, apkPath) {
  const { upload_url, sign } = uploadUrlInfo;
  const timestamp = Math.floor(Date.now() / 1000).toString();

  // 计算 api_sign（针对额外参数）
  const sigParams = { type: 'apk', sign, access_token: accessToken, timestamp };
  const api_sign = computeSign(sigParams, clientSecret);
  const qs = new URLSearchParams({ type: 'apk', sign, access_token: accessToken, timestamp, api_sign }).toString();
  const targetUrl = `${upload_url}?${qs}`;

  const form = new FormData();
  form.append('file', fs.createReadStream(apkPath), { filename: path.basename(apkPath) });
  form.append('type', 'apk');
  form.append('sign', sign);

  const data = await postForm(targetUrl, form);
  if (data.errno !== 0) throw new Error(`OPPO 上传 APK 失败: ${getOppoErrorMessage(data)}`);
  return data.data; // {url, md5}
}

async function updateApp(clientId, clientSecret, accessToken, pkgName, apkInfo, appInfo, apkResult, updateDesc) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const apkUrlJson = JSON.stringify([{ url: apkResult.url, md5: apkResult.md5, cpu_code: '0' }]);

  // 从已有 appInfo 中取必填字段，回填给接口
  const formParams = {
    pkg_name: pkgName,
    app_name: appInfo.app_name || '',
    version_code: String(apkInfo.versionCode || ''),
    apk_url: apkUrlJson,
    update_desc: updateDesc,
    online_type: '1',
    second_category_id: String(appInfo.ver_second_category_id ?? appInfo.second_category_id ?? ''),
    third_category_id: String(appInfo.ver_third_category_id ?? appInfo.third_category_id ?? ''),
    summary: appInfo.summary || '',
    detail_desc: appInfo.detail_desc || '',
    icon_url: appInfo.icon_url || '',
    pic_url: appInfo.pic_url || '',
    test_desc: appInfo.test_desc || '',
    business_username: appInfo.business_username || '',
    business_email: appInfo.business_email || '',
    business_mobile: appInfo.business_mobile || '',
    copyright_url: appInfo.copyright_url || appInfo.electronic_cert_url || '',
    electronic_cert_url: appInfo.electronic_cert_url || '',
    privacy_source_url: appInfo.privacy_source_url || appInfo.privacyUrl || '',
    age_level: String(appInfo.age_level || ''),
    adaptive_equipment: String(appInfo.adaptive_equipment || ''),
    access_token: accessToken,
    timestamp,
  };
  formParams.api_sign = computeSign(formParams, clientSecret);

  const data = await postFormEncoded(`${BASE_URL}/resource/v1/app/upd`, formParams);
  if (data.errno !== 0) throw new Error(`OPPO 提交失败: ${getOppoErrorMessage(data)}`);
}

function getOppoErrorMessage(data) {
  return data?.message || data?.data?.message || data?.msg || JSON.stringify(data);
}

// ── 签名工具 ────────────────────────────────────────────────────────────────

function buildSignParams(clientId, clientSecret, accessToken, extra = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const raw = { access_token: accessToken, timestamp, ...extra };
  raw.api_sign = computeSign(raw, clientSecret);
  return raw;
}

function computeSign(params, clientSecret) {
  const sorted = Object.keys(params)
    .filter((k) => k !== 'api_sign')
    .sort();
  const str = sorted.map((k) => `${k}=${params[k]}`).join('&');
  return hmacSha256(clientSecret, str);
}

// ── HTTP 工具 ───────────────────────────────────────────────────────────────

function getJson(urlStr) {
  return doRequest('GET', urlStr, null, {});
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
    logHttpRequest('OPPO', {
      method: 'POST',
      url: urlStr,
      headers: options.headers,
      body: { type: 'multipart/form-data', fields: ['file', 'type', 'sign'] },
    });
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf-8');
          logHttpResponse('OPPO', {
            method: 'POST',
            url: urlStr,
            statusCode: res.statusCode,
            headers: res.headers,
            body: text,
          });
          if (res.statusCode >= 400) {
            reject(new Error(`OPPO POST ${urlStr} 失败 HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          resolve(JSON.parse(text));
        }
        catch { reject(new Error('OPPO 上传响应解析失败')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    form.pipe(req);
  });
}

function postFormEncoded(urlStr, params) {
  const body = new URLSearchParams(params).toString();
  return doRequest('POST', urlStr, body, { 'Content-Type': 'application/x-www-form-urlencoded' });
}

function doRequest(method, urlStr, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const bodyBuf = body ? Buffer.from(body, 'utf-8') : null;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
        ...extraHeaders,
      },
      timeout: TIMEOUT,
    };
    logHttpRequest('OPPO', { method, url: urlStr, headers: options.headers, body });
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf-8');
          logHttpResponse('OPPO', {
            method,
            url: urlStr,
            statusCode: res.statusCode,
            headers: res.headers,
            body: text,
          });
          if (res.statusCode >= 400) {
            reject(new Error(`OPPO ${method} ${urlStr} 失败 HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          resolve(JSON.parse(text));
        }
        catch (e) { reject(new Error(`响应解析失败: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/**
 * 查询 OPPO 应用审核状态
 * @param {Record<string,string>} params {client_id, client_secret}
 * @param {string} packageName
 * @returns {{ state: string, versionCode: number, versionName: string }}
 */
export async function queryOppo(params, packageName) {
  const log = createChannelLogger('OPPO');
  const { client_id, client_secret } = params;
  log.info('查询审核状态开始', { packageName });

  const s1 = log.step('获取访问令牌');
  const accessToken = await getAccessToken(client_id, client_secret);
  s1.end();

  const s2 = log.step('获取应用信息', { packageName });
  const info = await getAppInfo(client_id, client_secret, accessToken, packageName);
  s2.end({ audit_status: info.audit_status, version_code: info.version_code, version_name: info.version_name });

  // 官方文档 audit_status：
  // 0=未发布, 1=审核中, 2=审核通过, 3=测试不通过, 4=运营审核中, 5=运营打回,
  // 6=运营通过, 7=定时发布, 11=资质审核通过, -11=资质审核不通过,
  // -22=报备提交成功, 22=已冻结, 111=上线, 222=下线, 444=审核不通过
  const auditStatus = Number(info.audit_status);
  let state;
  if (auditStatus === 111) state = 'Online';
  else if ([1, 2, 4, 6, 7, 11, -22].includes(auditStatus)) state = 'UnderReview';
  else if ([3, 5, -11, 444].includes(auditStatus)) state = 'Rejected';
  else state = 'Unknown';
  log.info('查询审核状态完成', { state, auditStatus, versionCode: info.version_code, versionName: info.version_name });
  return { state, versionCode: info.version_code ?? 0, versionName: info.version_name ?? '' };
}
