/**
 * 荣耀应用市场上传
 *
 * 完整流程（8 步）：
 * 1. 获取 access_token（OAuth2 form 表单）
 * 2. 获取 appId（按包名）
 * 3. 获取应用详情（取 languageInfo）
 * 4. 获取文件上传 URL（POST with file metadata）
 * 5. 上传 APK（multipart POST 到临时 URL）
 * 6. 绑定 APK 文件（update-file-info）
 * 7. 更新语言信息（版本说明）
 * 8. 提交审核
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import FormData from 'form-data';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { sha256File } from './utils/crypto.js';
import { retry } from './utils/retry.js';
import { getCachedToken } from './utils/token-cache.js';
import { logHttpRequest, logHttpResponse } from './utils/http-debug.js';
import { createChannelLogger } from './utils/channel-logger.js';

const TOKEN_URL = 'https://iam.developer.honor.com/auth/token';
const BASE_URL = 'https://appmarket-openapi-drcn.cloud.honor.com';
const TIMEOUT = 120000;

/**
 * @param {Record<string,string>} params   {client_id, client_secret}
 * @param {string} apkPath
 * @param {string} packageName
 * @param {string} updateDesc
 * @param {(progress:number, message:string)=>void} onProgress
 */
export async function uploadHonor(params, apkPath, packageName, updateDesc, onProgress) {
  const log = createChannelLogger('荣耀');
  const { client_id, client_secret } = params;
  log.info('上传流程开始', { apkPath, packageName, updateDescLength: updateDesc?.length });

  const s1 = log.step('获取访问令牌', { client_id });
  onProgress(5, '正在获取访问令牌...');
  let token, bearerToken;
  try {
    token = await getToken(client_id, client_secret);
    bearerToken = `Bearer ${token}`;
    s1.end();
  } catch (e) { s1.fail(e); throw e; }

  const s2 = log.step('获取应用 ID', { packageName });
  onProgress(15, '正在获取应用 ID...');
  let appId;
  try {
    appId = await getAppId(bearerToken, packageName);
    s2.end({ appId });
  } catch (e) { s2.fail(e); throw e; }

  const s3 = log.step('获取应用详情', { appId });
  onProgress(25, '正在获取应用详情...');
  let appInfo, langInfo;
  try {
    appInfo = await getAppInfo(bearerToken, appId);
    langInfo = appInfo.languageInfo?.[0];
    if (!langInfo) throw new Error('荣耀：未获取到应用语言信息');
    s3.end({ languageId: langInfo.languageId, appName: langInfo.appName });
  } catch (e) { s3.fail(e); throw e; }

  const fileName = path.basename(apkPath);
  const fileSize = fs.statSync(apkPath).size;
  const fileSha256 = await sha256File(apkPath);

  const s4 = log.step('获取上传地址', { appId, fileName, fileSize, fileSha256 });
  onProgress(35, '正在获取上传地址...');
  let uploadUrlInfo;
  try {
    uploadUrlInfo = await getUploadUrl(bearerToken, appId, fileName, fileSize, fileSha256);
    s4.end({ objectId: uploadUrlInfo.objectId, uploadUrl: uploadUrlInfo.uploadUrl?.substring(0, 80) + '...' });
  } catch (e) { s4.fail(e); throw e; }

  const s5 = log.step('上传 APK 文件', { uploadUrl: uploadUrlInfo.uploadUrl?.substring(0, 80) + '...', fileName, fileSize });
  onProgress(50, '正在上传 APK...');
  try {
    await uploadApkFile(bearerToken, uploadUrlInfo.uploadUrl, apkPath);
    s5.end();
  } catch (e) { s5.fail(e); throw e; }

  const s6 = log.step('绑定 APK 文件', { appId, objectId: uploadUrlInfo.objectId });
  onProgress(70, '正在绑定 APK 文件...');
  try {
    await bindApkFile(bearerToken, appId, uploadUrlInfo.objectId);
    s6.end();
  } catch (e) { s6.fail(e); throw e; }

  const s7 = log.step('更新版本说明', { appId, languageId: langInfo.languageId, updateDescLength: updateDesc?.length });
  onProgress(80, '正在更新版本说明...');
  try {
    await updateLangInfo(bearerToken, appId, langInfo, updateDesc);
    s7.end();
  } catch (e) { s7.fail(e); throw e; }

  const s8 = log.step('提交审核', { appId });
  onProgress(90, '正在提交审核...');
  try {
    await submitAudit(bearerToken, appId);
    s8.end();
  } catch (e) { s8.fail(e); throw e; }

  log.info('上传流程完成', { appId, packageName });
  onProgress(100, '提交成功');
}

async function getToken(clientId, clientSecret) {
  const cacheKey = `honor:${clientId}`;
  return retry(() => getCachedToken(cacheKey, async () => {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }).toString();
    const data = await doRequest('POST', TOKEN_URL, body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    if (!data.access_token) throw new Error(`荣耀获取 token 失败: ${JSON.stringify(data)}`);
    return data.access_token;
  }));
}

async function getAppId(bearerToken, pkgName) {
  // 查询为幂等操作，网络抖动/5xx 时重试
  return retry(async () => {
    const data = await doRequest('GET', `${BASE_URL}/openapi/v1/publish/get-app-id?pkgName=${encodeURIComponent(pkgName)}`, null, {
      Authorization: bearerToken,
    });
    checkCode(data, '获取 appId');
    const appId = data.data?.[0]?.appId;
    if (!appId) throw new Error('荣耀：未获取到 appId');
    return appId;
  });
}

async function getAppInfo(bearerToken, appId) {
  const data = await doRequest('GET', `${BASE_URL}/openapi/v1/publish/get-app-detail?appId=${appId}`, null, {
    Authorization: bearerToken,
  });
  checkCode(data, '获取应用详情');
  return data.data;
}

async function getCurrentRelease(bearerToken, appId) {
  const data = await doRequest('GET', `${BASE_URL}/openapi/v1/publish/get-app-current-release?appId=${appId}`, null, {
    Authorization: bearerToken,
  });
  checkCode(data, '获取当前发布版本');
  return data.data;
}

async function getUploadUrl(bearerToken, appId, fileName, fileSize, fileSha256) {
  const body = JSON.stringify([
    { fileName, fileType: 100, fileSize, fileSha256 },
  ]);
  const data = await doRequest(
    'POST',
    `${BASE_URL}/openapi/v1/publish/get-file-upload-url?appId=${appId}`,
    body,
    { Authorization: bearerToken, 'Content-Type': 'application/json;charset=UTF-8' },
    { preserveLargeIntegerFields: ['objectId'] }
  );
  checkCode(data, '获取上传地址');
  const info = data.data?.[0];
  if (!info) throw new Error('荣耀：未获取到上传地址');
  return info; // {uploadUrl, objectId}
}

async function uploadApkFile(bearerToken, uploadUrl, apkPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    const form = new FormData();
    form.append('file', fs.createReadStream(apkPath), { filename: path.basename(apkPath) });

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        Authorization: bearerToken,
        ...form.getHeaders(),
      },
      timeout: TIMEOUT,
    };
    logHttpRequest('荣耀', {
      method: 'POST',
      url: uploadUrl,
      headers: options.headers,
      body: { type: 'multipart/form-data', file: path.basename(apkPath) },
    });

    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        logHttpResponse('荣耀', {
          method: 'POST',
          url: uploadUrl,
          statusCode: res.statusCode,
          headers: res.headers,
          body: text,
        });
        try {
          const json = JSON.parse(text);
          if (json.code !== 0) {
            reject(new Error(`荣耀上传 APK 失败: ${json.msg || text}`));
          } else {
            resolve();
          }
        } catch {
          if (res.statusCode >= 400) {
            reject(new Error(`荣耀上传 APK HTTP ${res.statusCode}`));
          } else {
            resolve();
          }
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('荣耀上传超时')); });
    form.pipe(req);
  });
}

async function bindApkFile(bearerToken, appId, objectId) {
  const objectIdLiteral = normalizeHonorIntegerLiteral(objectId);
  const body = `{"bindingFileList":[{"objectId":${objectIdLiteral}}]}`;
  const data = await doRequest(
    'POST',
    `${BASE_URL}/openapi/v1/publish/update-file-info?appId=${appId}`,
    body,
    { Authorization: bearerToken, 'Content-Type': 'application/json;charset=UTF-8' }
  );
  checkCode(data, '绑定 APK 文件');
}

async function updateLangInfo(bearerToken, appId, langInfo, updateDesc) {
  const body = JSON.stringify({
    languageInfoList: [
      {
        languageId: langInfo.languageId || 'zh-CN',
        appName: langInfo.appName,
        intro: langInfo.intro,
        briefIntro: langInfo.briefIntro || '',
        newFeature: updateDesc,
      },
    ],
  });
  const data = await doRequest(
    'POST',
    `${BASE_URL}/openapi/v1/publish/update-language-info?appId=${appId}`,
    body,
    { Authorization: bearerToken, 'Content-Type': 'application/json;charset=UTF-8' }
  );
  checkCode(data, '更新版本说明');
}

async function submitAudit(bearerToken, appId) {
  // 荣耀 API 要求提交审核时必须指定发布类型，releaseType 为请求体顶层字段：
  //   1-全网发布  2-指定时间发布  3-分阶段发布
  // 注意：不能包在 publishInfo 里，否则接口会报错，版本停留在“准备提交”状态。
  const body = JSON.stringify({
    releaseType: 1,
  });
  const data = await doRequest(
    'POST',
    `${BASE_URL}/openapi/v1/publish/submit-audit?appId=${appId}`,
    body,
    { Authorization: bearerToken, 'Content-Type': 'application/json;charset=UTF-8' }
  );
  checkCode(data, '提交审核');
}

function checkCode(data, action) {
  if (data.code !== 0) {
    throw new Error(`荣耀 ${action} 失败: ${data.msg || JSON.stringify(data)}`);
  }
}

function normalizeHonorIntegerLiteral(value) {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`荣耀：非法 objectId ${raw}`);
  }
  return raw;
}

function parseJson(text, options = {}) {
  let normalized = text;
  for (const field of options.preserveLargeIntegerFields || []) {
    const matcher = new RegExp(`("${field}"\\s*:\\s*)(\\d{16,})`, 'g');
    normalized = normalized.replace(matcher, '$1"$2"');
  }
  return JSON.parse(normalized);
}

// ── HTTP 工具 ───────────────────────────────────────────────────────────────

function doRequest(method, urlStr, body, extraHeaders = {}, parseOptions = {}) {
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
    logHttpRequest('荣耀', { method, url: urlStr, headers: options.headers, body });
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf-8');
          logHttpResponse('荣耀', {
            method,
            url: urlStr,
            statusCode: res.statusCode,
            headers: res.headers,
            body: text,
          });
          if (res.statusCode >= 400) {
            reject(new Error(`荣耀 ${method} ${urlStr} 失败 HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          resolve(parseJson(text, parseOptions));
        }
        catch (e) { reject(new Error(`荣耀响应解析失败: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/**
 * 查询荣耀应用审核状态
 * @param {Record<string,string>} params {client_id, client_secret}
 * @param {string} packageName
 * @returns {{ state: string, versionCode: number, versionName: string }}
 */
export async function queryHonor(params, packageName) {
  const log = createChannelLogger('荣耀');
  const { client_id, client_secret } = params;
  log.info('查询审核状态开始', { packageName });

  const s1 = log.step('获取访问令牌');
  const token = await getToken(client_id, client_secret);
  const bearerToken = `Bearer ${token}`;
  s1.end();

  const s2 = log.step('获取应用 ID', { packageName });
  const appId = await getAppId(bearerToken, packageName);
  s2.end({ appId });

  const s3 = log.step('获取当前发布版本', { appId });
  const release = await getCurrentRelease(bearerToken, appId);
  s3.end({ auditResult: release?.auditResult, versionCode: release?.versionCode, versionName: release?.versionName });

  // auditResult: 1=审核通过(已上线), 0=审核中, 2=不通过
  const ar = release?.auditResult ?? -1;
  let state;
  if (ar === 1) state = 'Online';
  else if (ar === 0) state = 'UnderReview';
  else if (ar === 2) state = 'Rejected';
  else state = 'Unknown';
  log.info('查询审核状态完成', { state, versionCode: release?.versionCode, versionName: release?.versionName });
  return { state, versionCode: release?.versionCode ?? 0, versionName: release?.versionName ?? '' };
}
