import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// 应用配置目录：优先 CONFIG_DIR（推荐），兼容 CHANNEL_CONFIG_DIR；
// 两者均未设置且未指定单文件模式时，回退到 <仓库根>/config/apps（每个 <applicationId>.json 描述一个应用）
const CHANNEL_CONFIG_PATH = process.env.CHANNEL_CONFIG_PATH || '';
const CHANNEL_CONFIG_DIR = process.env.CONFIG_DIR
  || process.env.CHANNEL_CONFIG_DIR
  || (CHANNEL_CONFIG_PATH ? '' : path.resolve(MODULE_DIR, '../config/apps'));
// 数据根目录：APK 归档、任务持久化、日志统一挂载于此
const DATA_ROOT = process.env.BUILD_DATA_ROOT || path.resolve(MODULE_DIR, './data');
const APK_ROOT = process.env.APK_ROOT || path.join(DATA_ROOT, 'apks');

// 配置缓存：filePath → { config, mtimeMs, cachedAt }
const configCache = new Map();

// mtime 精度不足（如 NAS）时的兜底 TTL，超过即强制重读
const CONFIG_CACHE_TTL_MS = 30 * 1000;

const SENSITIVE_PARAM_NAMES = new Set([
  'client_secret',
  'access_secret',
  'privateKey',
  'appKey',
]);

function resolveConfigPath(appId) {
  if (CHANNEL_CONFIG_DIR) {
    if (!appId) throw new Error('多应用模式下需要指定 appId');
    const filePath = path.join(CHANNEL_CONFIG_DIR, `${appId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`应用配置文件不存在: ${filePath}（请在配置目录中创建 <applicationId>.json）`);
    }
    return filePath;
  }
  if (CHANNEL_CONFIG_PATH) {
    if (!fs.existsSync(CHANNEL_CONFIG_PATH)) {
      throw new Error(`渠道配置文件不存在: ${CHANNEL_CONFIG_PATH}`);
    }
    return CHANNEL_CONFIG_PATH;
  }
  throw new Error('环境变量 CHANNEL_CONFIG_DIR 或 CHANNEL_CONFIG_PATH 未设置，无法加载渠道配置');
}

export function listApps() {
  if (CHANNEL_CONFIG_DIR) {
    if (!fs.existsSync(CHANNEL_CONFIG_DIR)) return [];
    return fs.readdirSync(CHANNEL_CONFIG_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const raw = fs.readFileSync(path.join(CHANNEL_CONFIG_DIR, f), 'utf-8');
          const config = JSON.parse(raw);
          return {
            applicationId: config.applicationId,
            name: config.name,
            buildConfigured: Boolean(config.build?.script || process.env.BUILD_RELEASE_RUNNER),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  if (CHANNEL_CONFIG_PATH && fs.existsSync(CHANNEL_CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CHANNEL_CONFIG_PATH, 'utf-8');
      const config = JSON.parse(raw);
      return [{
        applicationId: config.applicationId,
        name: config.name,
        buildConfigured: Boolean(config.build?.script || process.env.BUILD_RELEASE_RUNNER),
      }];
    } catch {
      return [];
    }
  }
  return [];
}

export function readChannelConfig(appId) {
  const filePath = resolveConfigPath(appId);
  // mtime 未变且未超过兜底 TTL 时复用缓存，避免每次请求同步读盘阻塞事件循环
  const cached = configCache.get(filePath);
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (
    cached &&
    cached.mtimeMs === mtimeMs &&
    Date.now() - cached.cachedAt < CONFIG_CACHE_TTL_MS
  ) {
    return cached.config;
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const config = JSON.parse(raw);
  configCache.set(filePath, { config, mtimeMs, cachedAt: Date.now() });
  return config;
}

export function getSafeChannelConfig(appId) {
  const config = readChannelConfig(appId);
  return {
    name: config.name,
    applicationId: config.applicationId,
    enableChannel: config.enableChannel,
    build: resolveBuildFromConfig(config),
    extension: {
      updateDesc: config.extension?.updateDesc || '',
      apkDir: config.extension?.apkDir || '',
    },
    channels: (config.channels || []).map((ch) => ({
      name: ch.name,
      enable: ch.enable,
      params: (ch.params || [])
        .filter((p) => !SENSITIVE_PARAM_NAMES.has(p.name))
        .map((p) => ({ name: p.name, value: p.value })),
    })),
  };
}

export function getChannelParams(channelName, appId) {
  const config = readChannelConfig(appId);
  const channel = (config.channels || []).find((ch) => ch.name === channelName);
  if (!channel) throw new Error(`渠道不存在: ${channelName}`);
  const params = {};
  for (const p of channel.params || []) {
    params[p.name] = p.value;
  }
  return params;
}

export function getApplicationId(appId) {
  return readChannelConfig(appId).applicationId;
}

/**
 * 解析应用配置中的构建设置（build 段），环境变量作为兜底：
 *   {
 *     "build": {
 *       "projectRoot": "/app/project",          // Android 项目根目录（容器内路径）
 *       "script": "/app/project/build.sh"       // 用户自备 sh 构建脚本
 *     }
 *   }
 * 相对路径按配置目录解析；脚本入参与环境变量契约见 README。
 */
function resolveBuildFromConfig(config) {
  const raw = config?.build || {};
  const resolveMaybe = (value) => {
    if (!value) return '';
    if (path.isAbsolute(value)) return value;
    const baseDir = CHANNEL_CONFIG_DIR || process.cwd();
    return path.resolve(baseDir, value);
  };
  return {
    projectRoot: resolveMaybe(raw.projectRoot || process.env.BUILD_PROJECT_ROOT || ''),
    script: resolveMaybe(raw.script || process.env.BUILD_RELEASE_RUNNER || ''),
  };
}

export function getBuildConfig(appId) {
  return resolveBuildFromConfig(readChannelConfig(appId));
}

export function findApkForChannel(version, fileNameIdentify) {
  const versionDir = path.join(APK_ROOT, version);
  if (!fs.existsSync(versionDir)) return null;

  const results = [];
  walkDir(versionDir, (filePath) => {
    if (
      filePath.endsWith('.apk') &&
      path.basename(filePath).toLowerCase().includes(fileNameIdentify.toLowerCase())
    ) {
      results.push(filePath);
    }
  });
  return results[0] || null;
}

export function previewChannelApks(version, appId) {
  const config = readChannelConfig(appId);
  return (config.channels || []).map((ch) => {
    const identify = (ch.params || []).find((p) => p.name === 'fileNameIdentify')?.value || '';
    const apkPath = identify ? findApkForChannel(version, identify) : null;
    return {
      channelName: ch.name,
      enable: ch.enable,
      fileNameIdentify: identify,
      apkPath,
      apkName: apkPath ? path.basename(apkPath) : null,
    };
  });
}

function walkDir(dir, callback) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      walkDir(fullPath, callback);
    } else {
      callback(fullPath);
    }
  }
}
