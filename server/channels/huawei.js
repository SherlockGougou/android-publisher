/**
 * 华为应用市场上传
 *
 * 完整流程（8 步）：
 * 1. 获取 access_token（OAuth2）
 * 2. 获取 appId（按包名）
 * 3. 获取 OBS 上传 URL
 * 4. 上传 APK 到 OBS
 * 5. 提交文件信息，获取 pkgId
 * 6. 轮询编译状态（最多 3 分钟）
 * 7. 更新版本说明
 * 8. 提交审核
 */

import fs from 'fs';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { logHttpRequest, logHttpResponse } from './utils/http-debug.js';
import { createChannelLogger } from './utils/channel-logger.js';
import { retry } from './utils/retry.js';
import { getCachedToken, invalidateToken } from './utils/token-cache.js';

const BASE_URL = 'https://connect-api.cloud.huawei.com';
const TIMEOUT = 120000;

/**
 * @param {Record<string,string>} params   渠道参数 {client_id, client_secret}
 * @param {string} apkPath                 APK 文件绝对路径
 * @param {string} packageName             应用包名
 * @param {string} updateDesc              版本更新说明
 * @param {(progress:number, message:string)=>void} onProgress  进度回调
 */
export async function uploadHuawei(params, apkPath, packageName, updateDesc, onProgress) {
  const log = createChannelLogger('华为');
  const { client_id, client_secret } = params;
  log.info('上传流程开始', { apkPath, packageName, updateDescLength: updateDesc?.length });

  const s1 = log.step('获取访问令牌');
  onProgress(5, '正在获取访问令牌...');
  let accessToken;
  try {
    accessToken = await getAccessToken(client_id, client_secret);
    s1.end();
  } catch (e) { s1.fail(e); throw e; }

  const s2 = log.step('获取应用 ID', { packageName });
  onProgress(15, '正在获取应用 ID...');
  let appId;
  try {
    appId = await getAppId(client_id, accessToken, packageName);
    s2.end({ appId });
  } catch (e) { s2.fail(e); throw e; }

  const fileName = apkPath.split('/').pop();
  const fileSize = fs.statSync(apkPath).size;

  const s3 = log.step('获取上传地址', { appId, fileName, fileSize });
  onProgress(25, '正在获取上传地址...');
  let urlInfo;
  try {
    urlInfo = await getUploadUrl(client_id, accessToken, appId, fileName, fileSize);
    s3.end({ objectId: urlInfo.objectId });
  } catch (e) { s3.fail(e); throw e; }

  const s4 = log.step('上传 APK 到 OBS', { objectId: urlInfo.objectId, fileName });
  onProgress(35, '正在上传 APK...');
  try {
    await uploadToObs(urlInfo, apkPath);
    s4.end();
  } catch (e) { s4.fail(e); throw e; }

  const s5 = log.step('提交文件信息', { appId, fileName, objectId: urlInfo.objectId });
  onProgress(60, '正在提交文件信息...');
  let pkgId;
  try {
    pkgId = await submitFileInfo(client_id, accessToken, appId, fileName, urlInfo.objectId);
    s5.end({ pkgId });
  } catch (e) { s5.fail(e); throw e; }

  const s6 = log.step('轮询编译状态', { appId, pkgId });
  onProgress(70, '等待平台处理（可能需要 1-3 分钟）...');
  try {
    await pollCompileStatus(client_id, accessToken, appId, pkgId);
    s6.end();
  } catch (e) { s6.fail(e); throw e; }

  const s7 = log.step('更新版本说明', { appId });
  onProgress(85, '正在更新版本说明...');
  try {
    await updateVersionDesc(client_id, accessToken, appId, updateDesc);
    s7.end();
  } catch (e) { s7.fail(e); throw e; }

  const s8 = log.step('提交审核', { appId });
  onProgress(95, '正在提交审核...');
  try {
    await submitAudit(client_id, accessToken, appId);
    s8.end();
  } catch (e) { s8.fail(e); throw e; }

  log.info('上传流程完成', { appId, packageName });
  onProgress(100, '提交成功');
}

async function getAccessToken(clientId, clientSecret) {
  const cacheKey = `huawei:${clientId}`;
  return retry(() => getCachedToken(cacheKey, async () => {
    const body = JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    });
    const data = await postJson(`${BASE_URL}/api/oauth2/v1/token`, body);
    if (!data.access_token) throw new Error(`获取 access_token 失败: ${JSON.stringify(data)}`);
    return data.access_token;
  }));
}

async function getAppId(clientId, accessToken, packageName) {
  const url = `${BASE_URL}/api/publish/v2/appid-list?packageName=${encodeURIComponent(packageName)}`;
  return retry(async () => {
    try {
      const data = await getJson(url, {
        client_id: clientId,
        Authorization: `Bearer ${accessToken}`,
      });
      checkRet(data, '获取 appId');
      const appId = data.appids?.[0]?.value;
      if (!appId) throw new Error('未获取到应用 ID');
      return appId;
    } catch (err) {
      // token 失效时清除缓存，下次任务自动重新获取
      if (/HTTP 401/.test(err.message)) invalidateToken(`huawei:${clientId}`);
      throw err;
    }
  });
}

async function getUploadUrl(clientId, accessToken, appId, fileName, fileSize) {
  const url = `${BASE_URL}/api/publish/v2/upload-url/for-obs?appId=${appId}&fileName=${encodeURIComponent(fileName)}&contentLength=${fileSize}`;
  const data = await getJson(url, {
    client_id: clientId,
    Authorization: `Bearer ${accessToken}`,
  });
  checkRet(data, '获取上传地址');
  return data.urlInfo;
}

async function uploadToObs(urlInfo, apkPath) {
  const { url, objectId, headers: extraHeaders } = urlInfo;
  const fileSize = fs.statSync(apkPath).size;
  await putRaw(url, fs.createReadStream(apkPath), extraHeaders || {}, fileSize);
}

async function submitFileInfo(clientId, accessToken, appId, fileName, objectId) {
  const url = `${BASE_URL}/api/publish/v2/app-file-info?appId=${appId}`;
  const body = JSON.stringify({
    fileType: 5,
    files: [{ fileName, fileDestUrl: objectId }],
  });
  const data = await putJson(url, body, {
    client_id: clientId,
    Authorization: `Bearer ${accessToken}`,
  });
  checkRet(data, '提交文件信息');
  const pkgId = data.pkgVersion?.[0];
  if (!pkgId) throw new Error('未获取到 pkgId');
  return pkgId;
}

async function pollCompileStatus(clientId, accessToken, appId, pkgId) {
  const url = `${BASE_URL}/api/publish/v2/package/compile/status?appId=${appId}&pkgIds=${pkgId}`;
  // 指数退避：5/10/20/40/60/60 秒（60s 封顶），总时长约 3 分钟
  const intervals = [5, 10, 20, 40, 60, 60];
  for (const seconds of intervals) {
    // 单次请求可重试（网络抖动/5xx），业务性超时不重试
    const data = await retry(() => getJson(url, {
      client_id: clientId,
      Authorization: `Bearer ${accessToken}`,
    }));
    checkRet(data, '查询编译状态');
    const state = data.pkgStateList?.[0];
    const successStatus = state?.successStatus;
    if (successStatus === 0) return;
    if (successStatus === 2) throw new Error(`华为编译失败${state?.message ? `: ${state.message}` : ''}`);
    await sleep(seconds * 1000);
  }
  throw new Error('华为编译超时（3 分钟）');
}

async function updateVersionDesc(clientId, accessToken, appId, updateDesc) {
  const url = `${BASE_URL}/api/publish/v2/app-language-info?appId=${appId}`;
  const body = JSON.stringify({ newFeatures: updateDesc, lang: 'zh-CN' });
  const data = await putJson(url, body, {
    client_id: clientId,
    Authorization: `Bearer ${accessToken}`,
  });
  checkRet(data, '更新版本说明');
}

async function submitAudit(clientId, accessToken, appId) {
  const url = `${BASE_URL}/api/publish/v2/app-submit?appId=${appId}`;
  // 华为要求编译完成后等待 3-5 分钟再提交审核；遇到 "being compiled" 类瞬时错误时延迟重试
  const retryDelays = [60, 120, 180]; // 秒，总等待约 6 分钟
  let attempt = 0;
  for (;;) {
    const data = await postJson(url, '{}', {
      client_id: clientId,
      Authorization: `Bearer ${accessToken}`,
    });
    if (data.ret?.code === 0) return;
    const msg = data.ret?.msg || JSON.stringify(data);
    const retriable = /being compiled/i.test(msg) && attempt < retryDelays.length;
    if (!retriable) throw new Error(`提交审核 失败: ${msg}`);
    await sleep(retryDelays[attempt] * 1000);
    attempt++;
  }
}

function checkRet(data, action) {
  if (data.ret?.code !== 0) {
    throw new Error(`${action} 失败: ${data.ret?.msg || JSON.stringify(data)}`);
  }
}

// ── HTTP 工具 ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function request(method, urlStr, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const defaultHeaders = body ? { 'Content-Type': 'application/json;charset=UTF-8', 'Content-Length': Buffer.byteLength(body) } : {};
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { ...defaultHeaders, ...extraHeaders },
      timeout: TIMEOUT,
    };
    logHttpRequest('华为', { method, url: urlStr, headers: options.headers, body });
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        logHttpResponse('华为', {
          method,
          url: urlStr,
          statusCode: res.statusCode,
          headers: res.headers,
          body: text,
        });
        if (res.statusCode >= 400) {
          reject(new Error(`华为 ${method} ${urlStr} 失败 HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error(`华为响应解析失败: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (body) req.write(body);
    req.end();
  });
}

async function postJson(urlStr, body, extraHeaders = {}) {
  return request('POST', urlStr, body, extraHeaders);
}

async function getJson(urlStr, extraHeaders = {}) {
  return request('GET', urlStr, null, extraHeaders);
}

async function putJson(urlStr, body, extraHeaders = {}) {
  return request('PUT', urlStr, body, extraHeaders);
}

function putRaw(urlStr, stream, extraHeaders = {}, contentLength) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'PUT',
      headers: { 'Content-Length': contentLength, ...extraHeaders },
      timeout: TIMEOUT,
    };
    logHttpRequest('华为', {
      method: 'PUT',
      url: urlStr,
      headers: options.headers,
      body: `<Stream ${contentLength} bytes>`,
    });
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        logHttpResponse('华为', {
          method: 'PUT',
          url: urlStr,
          statusCode: res.statusCode,
          headers: res.headers,
          body: text,
        });
        if (res.statusCode >= 400) {
          reject(new Error(`OBS 上传失败 HTTP ${res.statusCode}`));
        } else {
          resolve();
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OBS 上传超时')); });
    stream.pipe(req);
    stream.on('error', reject);
  });
}

/**
 * 查询华为应用审核状态
 * @param {Record<string,string>} params {client_id, client_secret}
 * @param {string} packageName
 * @returns {{ state: string, versionCode: number, versionName: string }}
 */
export async function queryHuawei(params, packageName) {
  const log = createChannelLogger('华为');
  const { client_id, client_secret } = params;
  log.info('查询审核状态开始', { packageName });

  const s1 = log.step('获取访问令牌');
  const accessToken = await getAccessToken(client_id, client_secret);
  s1.end();

  const s2 = log.step('获取应用 ID', { packageName });
  const appId = await getAppId(client_id, accessToken, packageName);
  s2.end({ appId });

  const s3 = log.step('查询应用信息', { appId });
  const url = `${BASE_URL}/api/publish/v2/app-info?appId=${appId}`;
  const data = await getJson(url, {
    client_id,
    Authorization: `Bearer ${accessToken}`,
  });
  checkRet(data, '查询应用信息');
  const info = data.appInfo;
  s3.end({ releaseState: info?.releaseState, versionCode: info?.versionCode, versionNumber: info?.versionNumber });

  const releaseState = info?.releaseState ?? -1;
  let state;
  if (releaseState === 0) state = 'Online';
  else if (releaseState === 4 || releaseState === 5) state = 'UnderReview';
  else if (releaseState === 8) state = 'Rejected';
  else state = 'Unknown';
  log.info('查询审核状态完成', { state, versionCode: info?.versionCode, versionName: info?.versionNumber });
  return { state, versionCode: info?.versionCode ?? 0, versionName: info?.versionNumber ?? '' };
}
