const HTTP_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(process.env.CHANNEL_HTTP_DEBUG || '');

// HTTP 明细日志同时写入文件（server/data/logs/http-YYYY-MM-DD.log），仅 debug 开启时生效
import { writeHttpLog } from './file-logger.js';

const SENSITIVE_KEY_RE = /authorization|client_secret|access_secret|privatekey|password|sig|sign|api_sign|access_token|access_key|token/i;

export function isHttpDebugEnabled() {
  return HTTP_DEBUG_ENABLED;
}

export function logHttpRequest(channel, { method, url, headers, body }) {
  if (!HTTP_DEBUG_ENABLED) return;
  logBlock(channel, 'REQUEST', {
    method,
    url: redactUrl(url),
    headers: redactData(headers || {}),
    body: formatBody(body),
  });
}

export function logHttpResponse(channel, { method, url, statusCode, headers, body }) {
  if (!HTTP_DEBUG_ENABLED) return;
  logBlock(channel, 'RESPONSE', {
    method,
    url: redactUrl(url),
    statusCode,
    headers: redactData(headers || {}),
    body: formatBody(body),
  });
}

function logBlock(channel, phase, payload) {
  const text = JSON.stringify(payload, null, 2);
  const block = `[${channel}] HTTP ${phase}\n${text}`;
  writeHttpLog(block);
  console.log(block);
}

function formatBody(body) {
  if (body == null) return null;
  if (Buffer.isBuffer(body)) return `<Buffer ${body.length} bytes>`;
  if (typeof body === 'string') return redactText(body);
  return redactData(body);
}

function redactText(text) {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  try {
    return redactData(JSON.parse(trimmed));
  } catch {}

  try {
    const params = new URLSearchParams(trimmed);
    const entries = Array.from(params.entries());
    if (entries.length > 0) {
      return redactData(Object.fromEntries(entries));
    }
  } catch {}

  return trimmed;
}

/**
 * 对 URL query 中的敏感参数值打码（如 OPPO token 请求的 client_secret）
 */
function redactUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr) return urlStr;
  try {
    const url = new URL(urlStr);
    const params = url.searchParams;
    let changed = false;
    for (const key of Array.from(params.keys())) {
      if (SENSITIVE_KEY_RE.test(key)) {
        params.set(key, maskString(params.get(key) || ''));
        changed = true;
      }
    }
    if (!changed) return urlStr;
    return `${url.origin}${url.pathname}?${params.toString()}`;
  } catch {
    return urlStr;
  }
}

function redactData(data, parentKey = '') {
  if (data == null) return data;
  if (Array.isArray(data)) return data.map((item) => redactData(item, parentKey));
  if (typeof data === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = redactData(value, key);
    }
    return result;
  }
  if (typeof data === 'string' && SENSITIVE_KEY_RE.test(parentKey)) {
    return maskString(data);
  }
  return data;
}

function maskString(value) {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}