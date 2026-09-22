import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import archiver from 'archiver';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { BuildManager, serializeTask, isFinalStatus } from './buildManager.js';
import { channelPublisher, serializeTask as serializeChannelTask } from './channelPublisher.js';
import { getSafeChannelConfig, previewChannelApks, readChannelConfig, getApplicationId, getChannelParams, listApps } from './channelConfig.js';
import { queryHuawei } from './channels/huawei.js';
import { queryOppo } from './channels/oppo.js';
import { queryHonor } from './channels/honor.js';
import { queryVivo } from './channels/vivo.js';
import { queryMi } from './channels/mi.js';
import { queryTencent } from './channels/tencent.js';
import { parseVersionFromFilename, verifyApkPackage } from './apkUtils.js';
import { getChannelLogDir } from './channels/utils/file-logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 数据根目录：APK 归档、构建/渠道任务数据、日志统一挂载于此
const BUILD_DATA_ROOT = process.env.BUILD_DATA_ROOT || path.resolve(__dirname, './data');
const APK_ROOT = process.env.APK_ROOT || path.join(BUILD_DATA_ROOT, 'apks');
// 本地上传 APK 的留档目录（独立于 APK_ROOT，避免与版本库布局冲突）
const CHANNEL_UPLOAD_DIR = process.env.CHANNEL_UPLOAD_DIR || path.join(BUILD_DATA_ROOT, 'channel-uploads');
const PORT = Number(process.env.PORT) || 3000;

// 启动时检查 APK 目录是否存在
if (!fs.existsSync(APK_ROOT)) {
  console.warn(`[warn] APK_ROOT "${APK_ROOT}" does not exist, creating it...`);
  fs.mkdirSync(APK_ROOT, { recursive: true });
}

// 启动时确保本地上传目录存在
fs.mkdirSync(CHANNEL_UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

const buildManager = new BuildManager({
  apkRoot: APK_ROOT,
  dataRoot: BUILD_DATA_ROOT,
  port: PORT,
});

// ---- 文件上传：multer 存储引擎 ----
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const version = req.params.version;
    // 直接落到 <APK_ROOT>/<version>/ 下；服务端递归扫描该目录即可识别全部产物
    const dest = path.join(APK_ROOT, version);
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename(req, file, cb) {
    cb(null, file.originalname);
  },
});

function apkFileFilter(req, file, cb) {
  if (path.extname(file.originalname).toLowerCase() === '.apk') {
    cb(null, true);
  } else {
    cb(new Error('只允许上传 .apk 文件'));
  }
}

const upload = multer({ storage, fileFilter: apkFileFilter, defParamCharset: 'utf8' });

// ---- 本地上传（渠道发布）：落盘到 CHANNEL_UPLOAD_DIR，文件名带时间戳防覆盖（留档）----
const localUploadStorage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, CHANNEL_UPLOAD_DIR);
  },
  filename(req, file, cb) {
    const d = new Date();
    const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    const base = path.basename(file.originalname, path.extname(file.originalname));
    cb(null, `${base}_${ts}${path.extname(file.originalname)}`);
  },
});
const localUpload = multer({ storage: localUploadStorage, fileFilter: apkFileFilter, limits: { fileSize: 512 * 1024 * 1024 }, defParamCharset: 'utf8' });

// 递归读取所有 apk 文件，按版本号分组，并附带版本内最新 APK 更新时间
function getApkList() {
  if (!fs.existsSync(APK_ROOT)) {
    return { versions: {}, versionMeta: {} };
  }

  const versions = {};
  const versionMeta = {};
  const versionDirs = fs.readdirSync(APK_ROOT, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  versionDirs.forEach(version => {
    const versionPath = path.join(APK_ROOT, version);
    const files = [];
    let latestModifiedMs = 0;

    function walk(dir) {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      items.forEach(item => {
        const itemPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          walk(itemPath);
        } else if (item.isFile() && item.name.endsWith('.apk')) {
          files.push(path.relative(versionPath, itemPath));
          const stats = fs.statSync(itemPath);
          latestModifiedMs = Math.max(latestModifiedMs, stats.mtimeMs || 0);
        }
      });
    }
    walk(versionPath);
    versions[version] = files;
    versionMeta[version] = {
      latestModified: latestModifiedMs ? new Date(latestModifiedMs).toISOString() : '',
    };
  });

  return { versions, versionMeta };
}

// 获取所有 apk 文件列表
app.get('/api/apks', (req, res) => {
  const data = getApkList();
  res.json(data);
});

// 读取各版本目录下的 mapping.txt 文件列表
function getMappingList() {
  if (!fs.existsSync(APK_ROOT)) {
    return [];
  }

  const results = [];
  const versionDirs = fs.readdirSync(APK_ROOT, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  versionDirs.forEach(version => {
    const mappingPath = path.join(APK_ROOT, version, 'mapping.txt');
    if (fs.existsSync(mappingPath)) {
      const stats = fs.statSync(mappingPath);
      results.push({
        version,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    }
  });

  results.sort((a, b) =>
    b.version.localeCompare(a.version, undefined, { numeric: true, sensitivity: 'base' })
  );

  return results;
}

// 获取所有 mapping 文件列表
app.get('/api/mappings', (req, res) => {
  const mappings = getMappingList();
  res.json({ mappings });
});

// 获取应用列表（配置目录中的每个 <applicationId>.json 即一个应用）
app.get('/api/apps', (req, res) => {
  try {
    res.json({ success: true, data: listApps() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/builds/branches', async (req, res, next) => {
  try {
    const refreshRemote = String(req.query.refresh || '').toLowerCase() === 'true'
      || String(req.query.refresh || '') === '1';
    const appId = req.query.app || undefined;
    const data = await buildManager.listBranches({ appId, refreshRemote });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get('/api/builds/health', async (req, res, next) => {
  try {
    const data = await buildManager.getHealth(req.query.app || undefined);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.get('/api/builds/active', (req, res) => {
  res.json({ task: serializeTask(buildManager.getActiveTask()) });
});

app.get('/api/builds/history', (req, res) => {
  res.json({ tasks: buildManager.getHistory() });
});

app.post('/api/builds', async (req, res, next) => {
  try {
    const task = await buildManager.startTask(req.body || {});
    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

app.get('/api/builds/:taskId', (req, res) => {
  const task = buildManager.getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  res.json({ task: serializeTask(task) });
});

app.get('/api/builds/:taskId/logs', async (req, res, next) => {
  try {
    const logs = await buildManager.getTaskLogs(req.params.taskId);
    if (logs === null) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }
    res.type('text/plain; charset=utf-8');
    res.send(logs);
  } catch (error) {
    next(error);
  }
});

app.get('/api/builds/:taskId/stream', async (req, res, next) => {
  const task = buildManager.getTask(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const writeEvent = (eventName, payload) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const existingLogs = await buildManager.getTaskLogs(task.id);
    if (existingLogs) {
      existingLogs
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => writeEvent('log', { line, stream: 'history' }));
    }
    writeEvent('task', serializeTask(task));
  } catch (error) {
    next(error);
    return;
  }

  if (isFinalStatus(task.status)) {
    writeEvent('end', { taskId: task.id });
    res.end();
    return;
  }

  const unsubscribe = buildManager.subscribe(task.id, (event) => {
    writeEvent(event.type, event.payload);
    if (event.type === 'end') {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    }
  });

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.post('/api/builds/:taskId/cancel', async (req, res, next) => {
  try {
    const task = await buildManager.cancelTask(req.params.taskId);
    res.json({ task });
  } catch (error) {
    next(error);
  }
});


// 下载 apk 文件
app.get('/download/:version/*', (req, res) => {
  const { version } = req.params;
  const fileRelPath = req.params[0];
  const filePath = path.join(APK_ROOT, version, fileRelPath);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// 批量下载，打包为zip
app.post('/download-zip/:version', async (req, res) => {
  const { version } = req.params;
  const files = req.body.files;
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).send('No files');
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${version}-apks.zip"`);
  const archive = archiver('zip');
  archive.pipe(res);
  for (const f of files) {
    const filePath = path.join(APK_ROOT, version, f);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: path.basename(f) });
    }
  }
  await archive.finalize();
});

// 生成二维码
app.get('/api/qrcode', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  try {
    const qr = await QRCode.toDataURL(url);
    res.json({ qr });
  } catch (e) {
    res.status(500).send('QR code error');
  }
});

// 上传 APK 文件（支持同时上传多个）
// POST /api/upload/:version  multipart/form-data, field: files
app.post('/api/upload/:version', (req, res, next) => {
  upload.array('files')(req, res, (err) => {
    if (err) return next(err);
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '未收到任何文件，请确认字段名为 files' });
    }
    const uploaded = req.files.map((f) => ({
      name: f.originalname,
      size: f.size,
      path: path.relative(APK_ROOT, f.path),
    }));
    res.json({ uploaded });
  });
});

// ── 渠道发布路由 ───────────────────────────────────────────────────────────────

// GET /api/channel-publish/apps — 返回可用应用列表
app.get('/api/channel-publish/apps', (req, res) => {
  try {
    const apps = listApps();
    res.json({ success: true, data: apps });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/channel-publish/config — 返回脱敏渠道配置
app.get('/api/channel-publish/config', (req, res) => {
  try {
    const appId = req.query.app || undefined;
    const config = getSafeChannelConfig(appId);
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/channel-publish/preview/:version — 预览各渠道匹配的 APK
app.get('/api/channel-publish/preview/:version', (req, res) => {
  try {
    const { version } = req.params;
    const appId = req.query.app || undefined;
    const list = previewChannelApks(version, appId);
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/channel-publish/tasks — 创建渠道发布任务
app.post('/api/channel-publish/tasks', async (req, res) => {
  try {
    const { version, channels, updateDesc, appId } = req.body;
    if (!version || !Array.isArray(channels) || channels.length === 0) {
      return res.status(400).json({ success: false, error: '参数错误：需要 version 和 channels 数组' });
    }
    const task = await channelPublisher.createTask(version, channels, updateDesc || '', appId);
    res.json({ success: true, data: serializeChannelTask(task) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/channel-publish/local-tasks — 本地上传 APK 并创建渠道发布任务（multipart/form-data）
app.post('/api/channel-publish/local-tasks', (req, res) => {
  localUpload.single('apk')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    const filePath = req.file?.path;
    // 清理已落盘的 APK（失败分支统一调用）
    const cleanup = () => {
      if (filePath) {
        fs.unlink(filePath, (e) => {
          if (e) console.warn(`[channel-publish] 清理上传文件失败: ${e.message}`);
        });
      }
    };
    const fail = (status, message) => {
      cleanup();
      return res.status(status).json({ success: false, error: message });
    };
    try {
      if (!req.file) {
        return fail(400, '请选择要上传的 APK 文件');
      }
      const { appId, updateDesc } = req.body;
      if (!appId) {
        return fail(400, '缺少 appId 参数');
      }
      let channels;
      try {
        channels = JSON.parse(req.body.channels || '[]');
      } catch {
        return fail(400, 'channels 参数格式错误');
      }
      if (!Array.isArray(channels) || channels.length === 0) {
        return fail(400, '请至少选择一个渠道');
      }

      // 校验应用配置存在，并取得预期包名
      let config;
      try {
        config = readChannelConfig(appId);
      } catch {
        return fail(400, `应用配置不存在: ${appId}`);
      }

      // 包名校验（aapt 不可用时降级跳过并告警，不阻塞上传）
      const verify = await verifyApkPackage(filePath, config.applicationId);
      if (!verify.ok) {
        return fail(400, verify.reason);
      }
      if (verify.skipped) {
        console.warn(`[channel-publish] ${verify.reason}`);
      }

      // 版本号：优先用户填写，其次从文件名解析
      const version = (req.body.version || '').trim() || parseVersionFromFilename(req.file.originalname);

      const task = await channelPublisher.createTask(version, channels, updateDesc || '', appId, filePath);
      res.json({ success: true, data: serializeChannelTask(task) });
    } catch (err2) {
      // 任务创建失败时清理已落盘的 APK
      cleanup();
      res.status(500).json({ success: false, error: err2.message });
    }
  });
});

// GET /api/channel-publish/tasks/active — 活跃任务
app.get('/api/channel-publish/tasks/active', (req, res) => {
  res.json({ success: true, data: channelPublisher.getActiveTasks() });
});

// GET /api/channel-publish/tasks/history — 历史任务
app.get('/api/channel-publish/tasks/history', (req, res) => {
  res.json({ success: true, data: channelPublisher.getHistoryTasks() });
});

// GET /api/channel-publish/tasks/:taskId — 获取单个任务
app.get('/api/channel-publish/tasks/:taskId', (req, res) => {
  const task = channelPublisher.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ success: false, error: '任务不存在' });
  res.json({ success: true, data: serializeChannelTask(task) });
});

// GET /api/channel-publish/tasks/:taskId/stream — SSE 实时进度
app.get('/api/channel-publish/tasks/:taskId/stream', (req, res) => {
  const { taskId } = req.params;
  const task = channelPublisher.getTask(taskId);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 发送当前快照
  sendEvent('snapshot', serializeChannelTask(task));

  const onChannelUpdate = (payload) => {
    if (payload.taskId === taskId) {
      sendEvent('channel_update', payload);
    }
  };
  const onTaskDone = (payload) => {
    if (payload.taskId === taskId) {
      sendEvent('task_done', payload);
      cleanup();
    }
  };

  channelPublisher.on('channel_update', onChannelUpdate);
  channelPublisher.on('task_done', onTaskDone);

  const cleanup = () => {
    channelPublisher.off('channel_update', onChannelUpdate);
    channelPublisher.off('task_done', onTaskDone);
    res.end();
  };

  req.on('close', cleanup);
});

const CHANNEL_QUERY_FNS = {
  '华为': queryHuawei,
  'OPPO': queryOppo,
  '荣耀': queryHonor,
  'VIVO': queryVivo,
  '小米': queryMi,
  '腾讯应用宝': queryTencent,
};

// 渠道状态查询缓存（key: appId → channelName → result）
const channelStatusCache = new Map();

async function queryAllChannelStatuses(appId) {
  const config = readChannelConfig(appId);
  const packageName = getApplicationId(appId);
  const channels = (config.channels || []).filter(ch => ch.enable);
  const appCache = channelStatusCache.get(appId) || new Map();
  const results = await Promise.allSettled(
    channels.map(async (ch) => {
      const fn = CHANNEL_QUERY_FNS[ch.name];
      if (!fn) return { channelName: ch.name, state: 'Unknown', versionCode: 0, versionName: '' };
      const chParams = getChannelParams(ch.name, appId);
      try {
        const r = await fn(chParams, packageName);
        const result = { channelName: ch.name, ...r };
        appCache.set(ch.name, result);
        channelStatusCache.set(appId, appCache);
        return result;
      } catch (err) {
        const cached = appCache.get(ch.name);
        if (cached) {
          console.warn(`[channel-status] ${ch.name} 查询失败，使用缓存数据：`, err.message);
          return { ...cached, fromCache: true };
        }
        throw err;
      }
    })
  );
  return {
    appName: config.name || '应用',
    applicationId: packageName,
    data: results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return { channelName: channels[i].name, error: r.reason?.message || String(r.reason) };
    }),
  };
}

// GET /api/channel-publish/status — 查询各渠道审核状态
app.get('/api/channel-publish/status', async (req, res) => {
  try {
    const appId = req.query.app || undefined;
    const { data } = await queryAllChannelStatuses(appId);
    res.json({ results: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 按 Webhook 地址特征适配常见机器人格式（飞书/钉钉/企业微信），其余按通用 JSON 发送
function buildWebhookPayload(url, text, appName) {
  const lower = String(url).toLowerCase();
  if (lower.includes('feishu') || lower.includes('larksuite')) {
    return { msg_type: 'text', content: { text } };
  }
  if (lower.includes('dingtalk')) {
    return { msgtype: 'text', text: { content: text } };
  }
  if (lower.includes('weixin') || lower.includes('wecom')) {
    return { msgtype: 'text', text: { content: text } };
  }
  return {
    title: `渠道审核状态汇报（${appName}）`,
    text,
    source: 'android-publisher',
    sentAt: new Date().toISOString(),
  };
}

// POST /api/channel-publish/notify — 发送 Webhook 通知（支持飞书/钉钉/企业微信机器人及通用 JSON）
app.post('/api/channel-publish/notify', async (req, res) => {
  try {
    const appId = req.query.app || undefined;
    const config = readChannelConfig(appId);
    const webhookUrl = process.env.WEBHOOK_URL
      || process.env.FEISHU_WEBHOOK
      || config.extension?.webhookUrl
      || config.extension?.feishuWebhook;
    if (!webhookUrl) {
      return res.status(400).json({ success: false, error: '未配置 Webhook 地址（可设置环境变量 WEBHOOK_URL，或在应用配置 extension.webhookUrl 中填写）' });
    }

    const { appName, data } = await queryAllChannelStatuses(appId);

    const STATE_LABELS = {
      Online: '✅ 已上线',
      UnderReview: '🔄 审核中',
      Rejected: '❌ 被拒绝',
      Unknown: '❓ 未知',
    };
    const lines = data.map((item) => {
      if (item.error) return `${item.channelName}：⚠️ 查询失败`;
      const label = STATE_LABELS[item.state] || item.state || '未知';
      const ver = item.versionName ? ` (${item.versionName})` : '';
      return `${item.channelName}：${label}${ver}`;
    });
    const message = `📊 渠道审核状态汇报（${appName}）\n\n${lines.join('\n')}`;

    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWebhookPayload(webhookUrl, message, appName)),
    });
    const text = await resp.text();
    if (!resp.ok) {
      return res.status(502).json({ success: false, error: `Webhook 返回错误：${text}` });
    }
    res.json({ success: true, response: text });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 静态托管前端
const distDir = path.join(__dirname, '../web/dist');
app.use(express.static(distDir));

// SPA fallback：所有未匹配的路由都返回 index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.message?.includes('已有任务正在运行') ? 409 : err.statusCode || 400;
  res.status(status).json({ error: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Android Publisher 已启动: http://0.0.0.0:${PORT}`);
  console.log(`APK_ROOT: ${APK_ROOT}`);
  console.log(`BUILD_DATA_ROOT: ${BUILD_DATA_ROOT}`);
  console.log(`CHANNEL_UPLOAD_DIR: ${CHANNEL_UPLOAD_DIR}`);
  console.log(`CHANNEL_LOG_DIR: ${getChannelLogDir()}（渠道上传日志，按天滚动，保留 ${process.env.CHANNEL_LOG_RETENTION_DAYS || 30} 天）`);
});
