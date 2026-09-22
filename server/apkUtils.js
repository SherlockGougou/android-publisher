import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * 从 APK 文件名解析版本号
 * 规则：去掉 .apk 后缀后提取语义版本号（如 "app-2.4.6-26073001.apk" → "2.4.6"）
 * 提取不到则回退为完整文件名（去后缀）
 * @param {string} filename
 * @returns {string}
 */
export function parseVersionFromFilename(filename) {
  const base = String(filename || '').replace(/\.apk$/i, '');
  const match = base.match(/\d+\.\d+\.\d+/);
  if (match) return match[0];
  return base;
}

/**
 * 在 Android SDK 中查找 aapt 可执行文件（取 build-tools 下最新版本）
 * @returns {string|null}
 */
function findAapt() {
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  if (!sdkRoot) return null;
  const buildToolsDir = path.join(sdkRoot, 'build-tools');
  if (!fs.existsSync(buildToolsDir)) return null;
  const versions = fs.readdirSync(buildToolsDir)
    .filter((d) => fs.existsSync(path.join(buildToolsDir, d, 'aapt')))
    .sort()
    .reverse();
  if (versions.length === 0) return null;
  return path.join(buildToolsDir, versions[0], 'aapt');
}

/**
 * 校验 APK 包名是否与预期一致（使用 aapt dump badging）
 * @param {string} apkPath
 * @param {string} expectedPackageName
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>}
 */
export async function verifyApkPackage(apkPath, expectedPackageName) {
  const aapt = findAapt();
  if (!aapt) {
    return { ok: true, skipped: true, reason: '未找到 aapt，跳过包名校验' };
  }
  let stdout;
  try {
    const result = await execFileAsync(aapt, ['dump', 'badging', apkPath], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    stdout = result.stdout || '';
  } catch (err) {
    return { ok: false, reason: `APK 解析失败（aapt 无法读取安装包）: ${err.message}` };
  }
  const match = stdout.match(/^package:\s*name='([^']+)'/m);
  const actualPkg = match ? match[1] : null;
  if (!actualPkg) {
    return { ok: false, reason: '无法从 APK 中读取包名' };
  }
  if (actualPkg !== expectedPackageName) {
    return {
      ok: false,
      reason: `APK 包名 "${actualPkg}" 与应用配置 "${expectedPackageName}" 不一致，请确认上传了正确的安装包`,
    };
  }
  return { ok: true };
}
