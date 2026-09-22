import { useState, useEffect, useCallback } from 'react';

/**
 * 解析 pathname，返回 { view, version }
 * 支持：
 *   /                       → { view: 'distribution', version: null }
 *   /distribution           → { view: 'distribution', version: null }
 *   /distribution/4.2.0     → { view: 'distribution', version: '4.2.0' }
 *   /build                  → { view: 'build', version: null }
 *   /channel-publish        → { view: 'channelPublish', version: null }
 *   /mapping-files          → { view: 'mappingFiles', version: null }
 */
const PATH_TO_VIEW = {
    '': 'distribution',
    distribution: 'distribution',
    build: 'build',
    'channel-publish': 'channelPublish',
    'mapping-files': 'mappingFiles',
};

const VIEW_TO_PATH = {
    distribution: 'distribution',
    build: 'build',
    channelPublish: 'channel-publish',
    mappingFiles: 'mapping-files',
};

function parsePath(pathname) {
    const parts = pathname.replace(/^\//, '').split('/');
    const segment = parts[0] ?? '';
    const view = PATH_TO_VIEW[segment] ?? 'distribution';
    const version = view === 'distribution' && parts[1] ? decodeURIComponent(parts[1]) : null;
    return { view, version };
}

function buildPath(view, version) {
    const base = '/' + (VIEW_TO_PATH[view] ?? 'distribution');
    if (view === 'distribution' && version) {
        return base + '/' + encodeURIComponent(version);
    }
    return base;
}

export function useRouting() {
    const [route, setRoute] = useState(() => parsePath(window.location.pathname));

    // 监听浏览器前进/后退
    useEffect(() => {
        function onPopState() {
            setRoute(parsePath(window.location.pathname));
        }
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
    }, []);

    /** 导航到某个视图，可选指定版本 */
    const navigate = useCallback((view, version = null) => {
        const path = buildPath(view, version);
        if (path !== window.location.pathname) {
            window.history.pushState(null, '', path);
        }
        setRoute({ view, version });
    }, []);

    /** 仅替换版本（不产生新历史记录） */
    const replaceVersion = useCallback((version) => {
        setRoute((prev) => {
            const next = { ...prev, version };
            const path = buildPath(next.view, version);
            window.history.replaceState(null, '', path);
            return next;
        });
    }, []);

    return { view: route.view, urlVersion: route.version, navigate, replaceVersion };
}

export { buildPath };
