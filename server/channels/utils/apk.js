import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ApkReader = require('adbkit-apkreader');
const yauzl = require('yauzl');

const THIRTY_TWO_BIT_ABIS = new Set(['armeabi', 'armeabi-v7a', 'x86']);

export async function readApkManifest(apkPath) {
  const reader = await ApkReader.open(apkPath);
  const manifest = await reader.readManifest();
  return {
    packageName: manifest.package || '',
    versionCode: Number(manifest.versionCode) || 0,
    versionName: manifest.versionName || '',
  };
}

export function apkHas32BitLibs(apkPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(apkPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError) {
        reject(openError);
        return;
      }

      let hasNativeLib = false;
      let has32BitLib = false;

      zipFile.readEntry();
      zipFile.on('entry', (entry) => {
        if (/^lib\/[^/]+\/[^/]+/.test(entry.fileName)) {
          hasNativeLib = true;
          const abi = entry.fileName.split('/')[1];
          if (THIRTY_TWO_BIT_ABIS.has(abi)) {
            has32BitLib = true;
          }
        }
        zipFile.readEntry();
      });
      zipFile.on('end', () => resolve(!hasNativeLib || has32BitLib));
      zipFile.on('error', reject);
    });
  });
}