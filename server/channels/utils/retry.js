/**
 * 幂等请求重试工具
 *
 * 仅用于 token 获取、状态查询等幂等步骤；
 * 上传、提交审核、绑定文件等非幂等操作绝不重试（避免重复提交副作用）。
 */

// 默认可重试错误：超时、HTTP 5xx、HTTP 401、网络层错误
const RETRYABLE_RE = /超时|HTTP 5\d\d|HTTP 401|ETIMEDOUT|ECONNRESET/i;

/**
 * 指数退避重试（1s/2s，加 ±20% 抖动）
 * @param {() => Promise<any>} fn
 * @param {{ retries?: number, backoffMs?: number, shouldRetry?: (err: Error) => boolean }} [options]
 * @returns {Promise<any>}
 */
export async function retry(fn, options = {}) {
  const { retries = 2, backoffMs = 1000, shouldRetry } = options;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      const canRetry = shouldRetry ? shouldRetry(err) : RETRYABLE_RE.test(err.message || '');
      if (!canRetry) break;
      const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20% 抖动
      const delayMs = backoffMs * 2 ** attempt * jitter;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}
