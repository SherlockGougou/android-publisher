/**
 * 渠道 access_token 缓存
 *
 * 各应用商店的 access_token 有效期通常为 30 分钟，
 * 为避免每次上传/状态查询都重复获取 token，这里做带 TTL 的内存缓存。
 */

const TOKEN_TTL_MS = 25 * 60 * 1000; // 25 分钟，官方有效期 30 分钟的 80%

const tokenCache = new Map(); // cacheKey → { token, expiresAt }

/**
 * 获取缓存的 token；未命中或已过期时调用 fetcher 重新获取
 * @param {string} cacheKey 缓存键（如 `huawei:clientId`）
 * @param {() => Promise<string>} fetcher token 获取函数
 * @param {number} [ttlMs] 缓存有效期，默认 25 分钟
 * @returns {Promise<string>}
 */
export async function getCachedToken(cacheKey, fetcher, ttlMs = TOKEN_TTL_MS) {
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  const token = await fetcher();
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + ttlMs });
  return token;
}

/**
 * 清除指定 key 的 token 缓存
 * 业务接口返回 401 时调用，下一次获取将自动重新请求新 token
 */
export function invalidateToken(cacheKey) {
  tokenCache.delete(cacheKey);
}
