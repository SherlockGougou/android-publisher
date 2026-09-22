/**
 * 小米应用商店上传
 *
 * 完整流程（2 步）：
 * 1. 查询应用信息（/dev/query）
 * 2. 上传 APK（/dev/push）
 *
 * 签名算法：RSA X.509 证书加密
 * SIG JSON 格式：
 *   {password: privateKey, sig:[{name:"RequestData",hash:md5(requestData)},{name:"apk",hash:md5(apkFile)}]}
 * 将 SIG JSON 字符串用 X.509 公钥加密（1024-bit RSA/PKCS1，117 字节分块），转 Hex
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import FormData from 'form-data';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { md5File, miRsaEncrypt } from './utils/crypto.js';
import { retry } from './utils/retry.js';
import { logHttpRequest, logHttpResponse } from './utils/http-debug.js';
import { createChannelLogger } from './utils/channel-logger.js';

const BASE_URL = 'https://api.developer.xiaomi.com/devupload';
const TIMEOUT = 120000; // 普通请求（查询等）
const PUSH_TIMEOUT = 300000; // 大文件上传：传输+服务端校验入库可能较慢，放宽到 5 分钟

/**
 * @param {Record<string,string>} params   {account, publicKey, privateKey}
 * @param {string} apkPath
 * @param {string} packageName
 * @param {string} updateDesc
 * @param {(progress:number, message:string)=>void} onProgress
 */
export async function uploadMi(params, apkPath, packageName, updateDesc, onProgress) {
  const log = createChannelLogger('小米');
  const { account, publicKey, privateKey } = params;
  log.info('上传流程开始', { apkPath, packageName, updateDescLength: updateDesc?.length });

  const s1 = log.step('查询应用信息', { account, packageName });
  onProgress(10, '正在查询应用信息...');
  let appInfo;
  try {
    appInfo = await queryApp(account, publicKey, privateKey, packageName);
    s1.end({ appName: appInfo?.packageInfo?.appName || appInfo?.appName });
  } catch (e) { s1.fail(e); throw e; }

  const s2 = log.step('上传 APK', { packageName });
  onProgress(40, '正在上传 APK...');
  try {
    const result = await pushApk(account, publicKey, privateKey, packageName, appInfo, apkPath, updateDesc);
    if (result?.confirmed) log.info('上传响应超时，已通过查询确认版本入库', { packageName });
    s2.end();
  } catch (e) { s2.fail(e); throw e; }

  log.info('上传流程完成', { packageName });
  onProgress(100, '提交成功');
}

async function queryApp(account, publicKey, privateKey, packageName) {
  const requestData = JSON.stringify({ userName: account, packageName });
  const requestDataMd5 = md5Buffer(Buffer.from(requestData, 'utf-8'));

  const sigJson = JSON.stringify({
    password: privateKey,
    sig: [{ name: 'RequestData', hash: requestDataMd5 }],
  });
  const sig = miRsaEncrypt(publicKey, sigJson);

  const form = new FormData();
  form.append('RequestData', requestData);
  form.append('SIG', sig);

  // 查询为幂等操作，网络抖动/5xx 时重试
  const data = await retry(() => postForm(`${BASE_URL}/dev/query`, form));
  if (data.result !== 0) throw new Error(`小米查询应用失败: ${data.description || JSON.stringify(data)}`);
  return data;
}

async function pushApk(account, publicKey, privateKey, packageName, appInfo, apkPath, updateDesc) {
  const packageInfo = appInfo.packageInfo || {};
  const appName = packageInfo.appName || appInfo.appName || '';
  const appPackageName = packageInfo.packageName || packageName;
  if (!appName) throw new Error('小米：未获取到应用名称');

  const requestData = JSON.stringify({
    userName: account,
    synchroType: 1,
    appInfo: {
      appName,
      packageName: appPackageName,
      updateDesc,
    },
  });

  const requestDataMd5 = md5Buffer(Buffer.from(requestData, 'utf-8'));
  const apkMd5 = await md5File(apkPath);

  const sigJson = JSON.stringify({
    password: privateKey,
    sig: [
      { name: 'RequestData', hash: requestDataMd5 },
      { name: 'apk', hash: apkMd5 },
    ],
  });
  const sig = miRsaEncrypt(publicKey, sigJson);

  const form = new FormData();
  // 小米要求 apk 字段 filename 为空字符串
  form.append('apk', fs.createReadStream(apkPath), { filename: '' });
  form.append('RequestData', requestData);
  form.append('SIG', sig);

  const prevVersionCode = appInfo.packageInfo?.versionCode ?? 0;
  try {
    const data = await postForm(`${BASE_URL}/dev/push`, form, PUSH_TIMEOUT);
    if (data.result !== 0) throw new Error(`小米上传失败: ${data.description || data.message || JSON.stringify(data)}`);
  } catch (e) {
    // 超时/连接中断时结果不确定：小米服务端可能已完成入库但响应未返回。
    // 重新查询确认版本是否已入库，避免"实际成功但任务标记失败"的假失败。
    if (/超时|ETIMEDOUT|ECONNRESET/i.test(e.message)) {
      const uploaded = await confirmUploaded(account, publicKey, privateKey, packageName, prevVersionCode);
      if (uploaded) return { confirmed: true };
    }
    throw e;
  }
}

/**
 * 查询确认指定版本是否已入库（对比上传前后的 versionCode）
 * @returns {Promise<boolean>}
 */
async function confirmUploaded(account, publicKey, privateKey, packageName, prevVersionCode) {
  try {
    const data = await queryApp(account, publicKey, privateKey, packageName);
    const curVersionCode = data.packageInfo?.versionCode ?? 0;
    return curVersionCode > prevVersionCode;
  } catch {
    return false;
  }
}

function md5Buffer(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function postForm(urlStr, form, timeout = TIMEOUT) {
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
      timeout,
    };
    logHttpRequest('小米', {
      method: 'POST',
      url: urlStr,
      headers: options.headers,
      body: { type: 'multipart/form-data', fields: ['apk', 'RequestData', 'SIG'] },
    });
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf-8');
          logHttpResponse('小米', {
            method: 'POST',
            url: urlStr,
            statusCode: res.statusCode,
            headers: res.headers,
            body: text,
          });
          if (res.statusCode >= 400) {
            reject(new Error(`小米 POST ${urlStr} 失败 HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          resolve(JSON.parse(text));
        }
        catch { reject(new Error('小米响应解析失败')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('小米请求超时')); });
    form.pipe(req);
  });
}

/**
 * 查询小米应用审核状态
 * @param {Record<string,string>} params {account, publicKey, privateKey}
 * @param {string} packageName
 * @returns {{ state: string, versionCode: number, versionName: string }}
 */
export async function queryMi(params, packageName) {
  const log = createChannelLogger('小米');
  const { account, publicKey, privateKey } = params;
  log.info('查询审核状态开始', { packageName });

  const s1 = log.step('查询应用信息', { account, packageName });
  const data = await queryApp(account, publicKey, privateKey, packageName);
  s1.end({ updateVersion: data.updateVersion, versionCode: data.packageInfo?.versionCode });

  // updateVersion: true=可提交新版本(=已上线), false=审核中
  const state = data.updateVersion ? 'Online' : 'UnderReview';
  const pkg = data.packageInfo || {};
  log.info('查询审核状态完成', { state, versionCode: pkg.versionCode, versionName: pkg.versionName });
  return { state, versionCode: pkg.versionCode ?? 0, versionName: pkg.versionName ?? '' };
}
