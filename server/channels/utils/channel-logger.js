/**
 * 渠道流程日志工具
 *
 * 为每个渠道的每个业务步骤提供结构化日志，始终输出到 stdout（Docker 可查）。
 * 敏感字段（token、secret、password）自动脱敏。
 *
 * 日志格式：
 *   [YYYY-MM-DD HH:mm:ss] [渠道] [STEP] 步骤名 | 耗时: Xms | 数据: {...}
 *   [YYYY-MM-DD HH:mm:ss] [渠道] [ERROR] 步骤名 | 耗时: Xms | 错误: ... | 数据: {...}
 *
 * 日志同时输出到 stdout（Docker 实时查看）与文件（server/data/logs/channel-YYYY-MM-DD.log，事后分析）。
 */

import { writeChannelLog } from './file-logger.js';

const SENSITIVE_KEY_RE = /authorization|client_secret|access_secret|privatekey|password|sig|sign|api_sign|access_token|access_key|token/i;

function mask(value) {
  if (typeof value !== 'string') return value;
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function sanitize(obj, parentKey = '') {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map((item) => sanitize(item, parentKey));
  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitize(value, key);
    }
    return result;
  }
  if (typeof obj === 'string' && SENSITIVE_KEY_RE.test(parentKey)) {
    return mask(obj);
  }
  return obj;
}

function timestamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 创建渠道日志器
 * @param {string} channel  渠道名称，如 '荣耀', '华为', '小米', 'OPPO', 'VIVO', '腾讯应用宝'
 * @returns {{ step, error, info }}
 */
export function createChannelLogger(channel) {
  function log(level, stepName, data, elapsed) {
    const ts = timestamp();
    const elapsedStr = elapsed != null ? ` | 耗时: ${elapsed}ms` : '';
    const dataStr = data ? ` | ${JSON.stringify(sanitize(data))}` : '';
    const msg = `[${ts}] [${channel}] [${level}] ${stepName}${elapsedStr}${dataStr}`;
    writeChannelLog(msg);
    if (level === 'ERROR') {
      console.error(msg);
    } else {
      console.log(msg);
    }
  }

  return {
    /**
     * 记录流程步骤开始/完成
     * @param {string} stepName  步骤名称
     * @param {object} [data]    附带数据（自动脱敏）
     * @returns {{ end: (result?: object) => void, fail: (error: Error|object) => void, elapsed: () => number }}
     */
    step(stepName, data) {
      const start = Date.now();
      log('STEP', `${stepName} - 开始`, data);
      return {
        end(result) {
          const elapsed = Date.now() - start;
          log('STEP', `${stepName} - 完成`, result, elapsed);
        },
        fail(error) {
          const elapsed = Date.now() - start;
          const errData = error instanceof Error
            ? { message: error.message, stack: error.stack }
            : { error };
          log('ERROR', `${stepName} - 失败`, errData, elapsed);
        },
        elapsed() {
          return Date.now() - start;
        },
      };
    },

    /**
     * 直接记录一条信息
     */
    info(stepName, data) {
      log('INFO', stepName, data);
    },

    /**
     * 直接记录一条错误
     */
    error(stepName, data) {
      log('ERROR', stepName, data);
    },
  };
}
