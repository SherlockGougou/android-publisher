import { useEffect, useMemo, useState } from 'react';
import { API, DOWNLOAD } from '../constants';

function normalizeApkPayload(payload) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.versions) {
        return {
            versions: payload.versions || {},
            versionMeta: payload.versionMeta || {},
        };
    }

    return {
        versions: payload && typeof payload === 'object' ? payload : {},
        versionMeta: {},
    };
}

function getTimestamp(value) {
    if (!value) return 0;
    const timestamp = new Date(value).getTime();
    return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareVersionsByLatestModified(left, right, versionMeta) {
    const timeDiff = getTimestamp(versionMeta[right]?.latestModified) - getTimestamp(versionMeta[left]?.latestModified);
    if (timeDiff !== 0) return timeDiff;
    return right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * 获取 APK 列表与文件元数据（Last-Modified）。
 * @returns {{ data, versions, version, setVersion, files, fileMeta, versionMeta }}
 */
export function useApkData() {
    const [data, setData] = useState({});
    const [version, setVersion] = useState('');
    const [fileMeta, setFileMeta] = useState({});
    const [versionMeta, setVersionMeta] = useState({});
    const [reloadTick, setReloadTick] = useState(0);

    // 获取 APK 列表
    useEffect(() => {
        fetch(API)
            .then((r) => r.json())
            .then((payload) => {
                const normalized = normalizeApkPayload(payload);
                setData(normalized.versions);
                setVersionMeta(normalized.versionMeta);
            })
            .catch((err) => console.error('获取 APK 列表失败', err));
    }, [reloadTick]);

    const versions = useMemo(
        () =>
            Object.keys(data)
                .slice()
                .sort((left, right) => compareVersionsByLatestModified(left, right, versionMeta)),
        [data, versionMeta],
    );

    // 自动选中最新版本
    useEffect(() => {
        if (!versions.length) {
            if (version) {
                setVersion('');
            }
            return;
        }

        if (version && versions.includes(version)) return;
        setVersion(versions[0]);
    }, [versions, version]);

    const files = useMemo(() => (version ? data[version] || [] : []), [data, version]);

    // 批量获取文件 Last-Modified
    useEffect(() => {
        if (!version || !files.length) return;
        const metaForVersion = fileMeta[version] || {};
        const missing = files.filter((f) => !metaForVersion[f]);
        if (!missing.length) return;

        let isMounted = true;
        const controller = new AbortController();

        Promise.all(
            missing.map(async (filename) => {
                try {
                    const response = await fetch(`${DOWNLOAD}/${version}/${filename}`, {
                        method: 'HEAD',
                        signal: controller.signal,
                    });
                    return {
                        filename,
                        lastModified: response.ok
                            ? response.headers.get('Last-Modified') || '未知'
                            : '未知',
                    };
                } catch {
                    return { filename, lastModified: '未知' };
                }
            }),
        ).then((results) => {
            if (!isMounted) return;
            setFileMeta((prev) => {
                const next = { ...prev };
                const scoped = { ...(next[version] || {}) };
                results.forEach(({ filename, lastModified }) => {
                    scoped[filename] = lastModified;
                });
                next[version] = scoped;
                return next;
            });
        });

        return () => {
            isMounted = false;
            controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [files, version]);

    function refresh() {
        setReloadTick((value) => value + 1);
    }

    return { data, versions, version, setVersion, files, fileMeta, versionMeta, refresh };
}
