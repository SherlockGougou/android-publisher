/**
 * 渠道日志文件落盘工具
 *
 * 将渠道上传的步骤日志与 HTTP 明细日志按天滚动写入文件，
 * 辅助上传问题的事后分析（Docker stdout 日志随容器生命周期丢失）。
 *
 * 文件位置：CHANNEL_LOG_DIR（默认 <项目>/server/data/logs）
 *   - channel-YYYY-MM-DD.log  渠道流程步骤日志（始终记录）
 *   - http-YYYY-MM-DD.log     HTTP 请求/响应明细（仅 CHANNEL_HTTP_DEBUG 开启时）
 *   - <UUID>.log              构建任务日志（buildManager 写入，一并纳入保留清理）
 *
 * 大小控制：
 *   - 按天滚动：每天一个新文件
 *   - 单文件上限：CHANNEL_LOG_MAX_SIZE（默认 50MB），超限自动滚动为 -1/-2... 后缀文件
 *   - 保留天数：CHANNEL_LOG_RETENTION_DAYS（默认 30 天），每天首次写入时清理过期文件
 *
 * 写入串行化（写队列），避免多渠道并发上传时日志交错；
 * 写入失败静默处理，日志系统不影响主流程。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// 默认 <数据根目录>/logs（BUILD_DATA_ROOT，默认 <server>/data，已被 .gitignore 忽略）
const LOG_DIR = process.env.CHANNEL_LOG_DIR
  || (process.env.BUILD_DATA_ROOT
    ? path.resolve(process.env.BUILD_DATA_ROOT, 'logs')
    : path.resolve(MODULE_DIR, '../../data/logs'));
const RETENTION_DAYS = Number(process.env.CHANNEL_LOG_RETENTION_DAYS) || 30;
// 单文件大小上限（默认 50MB），超限自动滚动为 -1/-2... 后缀文件
const MAX_FILE_SIZE = Number(process.env.CHANNEL_LOG_MAX_SIZE) || 50 * 1024 * 1024;

// 需要纳入保留清理的日志文件：
// 1. 渠道日志（按天滚动，含超限滚动出的 -N 后缀文件）
// 2. 构建任务日志（buildManager 写入的 <UUID>.log，原不受清理约束会无限累积）
const LOG_FILE_RES = [
  /^(channel|http)-\d{4}-\d{2}-\d{2}(-\d+)?\.log$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/i,
];

// fileName → { fd, date, written }，跨天或超限自动关闭重开
const fdCache = new Map();

// 串行写队列：所有写操作排队执行，保证行不交错
let writeChain = Promise.resolve();

// 过期文件每天只清理一次
let lastCleanupDate = '';

function dateStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function enqueue(job) {
  writeChain = writeChain.then(job).catch(() => {});
}

function openFd(fileName, date) {
  const cached = fdCache.get(fileName);
  if (cached && cached.date === date) return cached;
  if (cached) {
    try { fs.closeSync(cached.fd); } catch { /* 忽略关闭失败 */ }
    fdCache.delete(fileName);
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const fd = fs.openSync(path.join(LOG_DIR, fileName), 'a');
  // written 初始化为文件当前大小：进程重启后仍能正确累计，避免首行误触发滚动
  const entry = { fd, date, written: fs.fstatSync(fd).size };
  fdCache.set(fileName, entry);
  return entry;
}

/**
 * 当前文件超过大小上限时：关闭并重命名为 <name>-N.log（N 递增），再开新文件继续写
 */
function rotateFile(fileName, date) {
  const cached = fdCache.get(fileName);
  if (cached) {
    try { fs.closeSync(cached.fd); } catch { /* 忽略关闭失败 */ }
    fdCache.delete(fileName);
  }
  const base = path.join(LOG_DIR, fileName);
  if (!fs.existsSync(base)) return;
  let index = 1;
  let rotated;
  do {
    rotated = `${base.replace(/\.log$/, '')}-${index}.log`;
    index++;
  } while (fs.existsSync(rotated));
  fs.renameSync(base, rotated);
}

function writeLogFile(kind, text) {
  try {
    const date = dateStr();
    const fileName = `${kind}-${date}.log`;
    const line = text + '\n';
    const size = Buffer.byteLength(line);
    enqueue(() => {
      try {
        let entry = openFd(fileName, date);
        if (entry.written + size > MAX_FILE_SIZE) {
          rotateFile(fileName, date);
          entry = openFd(fileName, date);
        }
        fs.writeSync(entry.fd, line);
        entry.written += size;
      } catch (e) {
        console.warn(`[file-logger] 写入 ${fileName} 失败: ${e.message}`);
      }
    });
    cleanupIfNeeded(date);
  } catch { /* 日志系统异常不影响主流程 */ }
}

/**
 * 渠道流程步骤日志（始终记录）
 * @param {string} line 已格式化的单行日志（含时间戳，已脱敏）
 */
export function writeChannelLog(line) {
  writeLogFile('channel', line);
}

/**
 * HTTP 请求/响应明细日志（仅 debug 开关开启时由调用方触发）
 * @param {string} block 多行日志块（已脱敏）
 */
export function writeHttpLog(block) {
  writeLogFile('http', block);
}

/**
 * 日志目录（供启动信息展示）
 */
export function getChannelLogDir() {
  return LOG_DIR;
}

/**
 * 删除超过保留天数的历史日志文件，每天只执行一次
 */
function cleanupIfNeeded(date) {
  if (lastCleanupDate === date) return;
  lastCleanupDate = date;
  enqueue(() => {
    try {
      const files = fs.readdirSync(LOG_DIR);
      const now = Date.now();
      const expireMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
      for (const f of files) {
        if (!LOG_FILE_RES.some((re) => re.test(f))) continue;
        const filePath = path.join(LOG_DIR, f);
        const mtime = fs.statSync(filePath).mtimeMs;
        if (now - mtime > expireMs) {
          fs.unlinkSync(filePath);
        }
      }
    } catch { /* 清理失败不影响日志写入 */ }
  });
}
