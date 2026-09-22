import { useEffect, useRef, useState, useCallback } from 'react';

const CHANNEL_API = '/api/channel-publish';

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const message = typeof payload === 'string' ? payload : payload?.error || '请求失败';
    throw new Error(message);
  }
  return payload;
}

export function useChannelPublish() {
  const [apps, setApps] = useState([]);
  const [selectedApp, setSelectedApp] = useState('');
  const [config, setConfig] = useState(null);
  const [versions, setVersions] = useState([]);
  const [versionMeta, setVersionMeta] = useState({});
  const [selectedVersion, setSelectedVersion] = useState('');
  const [apkPreview, setApkPreview] = useState([]);
  const [selectedChannels, setSelectedChannels] = useState(new Set());
  const [updateDesc, setUpdateDesc] = useState('');
  const [activeTask, setActiveTask] = useState(null);
  const [history, setHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedFile, setSelectedFile] = useState(null);
  const [localVersion, setLocalVersion] = useState('');
  const sseRef = useRef(null);

  // 加载应用列表
  useEffect(() => {
    let cancelled = false;
    request(`${CHANNEL_API}/apps`)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data.length > 0) {
          setApps(res.data);
          setSelectedApp(res.data[0].applicationId);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 当应用切换时重新加载数据
  useEffect(() => {
    if (!selectedApp) return;
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      setActionError('');
      try {
        const appParam = encodeURIComponent(selectedApp);
        const [configRes, apksRes, activeRes, historyRes] = await Promise.all([
          request(`${CHANNEL_API}/config?app=${appParam}`),
          request('/api/apks'),
          request(`${CHANNEL_API}/tasks/active`),
          request(`${CHANNEL_API}/tasks/history`),
        ]);
        if (cancelled) return;

        if (configRes.success) {
          const cfg = configRes.data;
          setConfig(cfg);
          setUpdateDesc(cfg.extension?.updateDesc || '');
          const enabledNames = (cfg.channels || [])
            .filter((c) => c.enable)
            .map((c) => c.name);
          setSelectedChannels(new Set(enabledNames));
        }
        if (apksRes?.versions && typeof apksRes.versions === 'object') {
          const meta = apksRes.versionMeta || {};
          // 全量版本，按构建日期（latestModified）降序排列；无构建时间或时间相同的按版本号字典序降序兜底
          const timeOf = (v) => {
            const t = meta[v]?.latestModified ? new Date(meta[v].latestModified).getTime() : NaN;
            return Number.isNaN(t) ? -Infinity : t;
          };
          const allVersions = Object.keys(apksRes.versions)
            .sort((a, b) => (timeOf(b) - timeOf(a)) || b.localeCompare(a));
          setVersions(allVersions);
          setVersionMeta(meta);
          if (allVersions.length > 0) {
            setSelectedVersion(allVersions[0]);
          }
        }
        if (activeRes.success && activeRes.data.length > 0) {
          setActiveTask(activeRes.data[0]);
        } else {
          setActiveTask(null);
        }
        if (historyRes.success) {
          setHistory(historyRes.data.slice(0, 20));
        }
      } catch (err) {
        if (!cancelled) setActionError(err.message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [selectedApp, reloadTick]);

  // 当版本变化时刷新 APK 预览
  useEffect(() => {
    if (!selectedVersion || !selectedApp) return;
    let cancelled = false;
    const appParam = encodeURIComponent(selectedApp);
    request(`${CHANNEL_API}/preview/${encodeURIComponent(selectedVersion)}?app=${appParam}`)
      .then((res) => {
        if (!cancelled && res.success) setApkPreview(res.data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedVersion, selectedApp]);

  const subscribeToTask = useCallback((taskId) => {
    if (sseRef.current) sseRef.current.close();
    const es = new EventSource(`${CHANNEL_API}/tasks/${taskId}/stream`);
    sseRef.current = es;

    es.addEventListener('snapshot', (e) => {
      const data = JSON.parse(e.data);
      setActiveTask(data);
    });
    es.addEventListener('channel_update', (e) => {
      const { channelName, status, progress, message } = JSON.parse(e.data);
      setActiveTask((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          channelResults: {
            ...prev.channelResults,
            [channelName]: { ...prev.channelResults[channelName], status, progress, message },
          },
        };
      });
    });
    es.addEventListener('task_done', (e) => {
      const { status } = JSON.parse(e.data);
      setActiveTask((prev) => prev ? { ...prev, status } : prev);
      es.close();
      sseRef.current = null;
      setReloadTick((v) => v + 1);
    });
    es.onerror = () => { es.close(); sseRef.current = null; };
  }, []);

  const submitPublish = useCallback(async () => {
    if (!selectedVersion || selectedChannels.size === 0) {
      setActionError('请选择版本和至少一个渠道');
      return;
    }
    setActionError('');
    setIsSubmitting(true);
    try {
      const res = await request(`${CHANNEL_API}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: selectedVersion,
          channels: Array.from(selectedChannels),
          updateDesc,
          appId: selectedApp,
        }),
      });
      if (res.success) {
        setActiveTask(res.data);
        subscribeToTask(res.data.taskId);
      }
    } catch (err) {
      setActionError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  }, [selectedVersion, selectedChannels, updateDesc, selectedApp, subscribeToTask]);

  // 本地上传模式：选择文件时自动从文件名解析版本号（如 "app-2.4.6-26073001.apk" → "2.4.6"）
  const handleFileSelect = useCallback((file) => {
    setSelectedFile(file);
    if (file) {
      const base = file.name.replace(/\.apk$/i, '');
      const match = base.match(/\d+\.\d+\.\d+/);
      setLocalVersion(match ? match[0] : base);
    } else {
      setLocalVersion('');
    }
  }, []);

  // 本地上传模式：上传 APK 文件并创建渠道发布任务（multipart/form-data）
  const submitLocalPublish = useCallback(async () => {
    if (!selectedFile || selectedChannels.size === 0) {
      setActionError('请选择 APK 文件和至少一个渠道');
      return;
    }
    setActionError('');
    setIsSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('apk', selectedFile);
      formData.append('appId', selectedApp);
      formData.append('channels', JSON.stringify(Array.from(selectedChannels)));
      formData.append('updateDesc', updateDesc);
      formData.append('version', localVersion);
      const res = await request(`${CHANNEL_API}/local-tasks`, {
        method: 'POST',
        body: formData,
      });
      if (res.success) {
        setActiveTask(res.data);
        subscribeToTask(res.data.taskId);
      }
    } catch (err) {
      setActionError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  }, [selectedFile, selectedChannels, selectedApp, updateDesc, localVersion, subscribeToTask]);

  const toggleChannel = useCallback((name) => {
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  useEffect(() => {
    if (activeTask?.status === 'running' && activeTask?.taskId) {
      subscribeToTask(activeTask.taskId);
    }
    return () => {};
  }, [activeTask?.taskId]);

  const [isQuerying, setIsQuerying] = useState(false);
  const [queryResults, setQueryResults] = useState({});
  const [queryError, setQueryError] = useState('');

  const queryStatus = useCallback(async () => {
    if (!selectedApp) return;
    setIsQuerying(true);
    setQueryError('');
    try {
      const appParam = encodeURIComponent(selectedApp);
      const res = await request(`${CHANNEL_API}/status?app=${appParam}`);
      const map = {};
      for (const item of res.results || []) {
        map[item.channelName] = item;
      }
      setQueryResults(map);
    } catch (err) {
      setQueryError(err.message);
    } finally {
      setIsQuerying(false);
    }
  }, [selectedApp]);

  const hasAutoQueried = useRef(false);
  useEffect(() => {
    if (!isLoading && selectedApp && !hasAutoQueried.current) {
      hasAutoQueried.current = true;
      queryStatus();
    }
  }, [isLoading, selectedApp, queryStatus]);

  // 切换应用时重置自动查询标记与已选文件
  useEffect(() => {
    hasAutoQueried.current = false;
    setQueryResults({});
    setSelectedFile(null);
    setLocalVersion('');
  }, [selectedApp]);

  const [isNotifying, setIsNotifying] = useState(false);
  const [notifyError, setNotifyError] = useState('');
  const [notifySuccess, setNotifySuccess] = useState(false);

  const sendWebhookNotify = useCallback(async () => {
    if (!selectedApp) return;
    setIsNotifying(true);
    setNotifyError('');
    setNotifySuccess(false);
    try {
      const appParam = encodeURIComponent(selectedApp);
      const res = await request(`${CHANNEL_API}/notify?app=${appParam}`, { method: 'POST' });
      if (res.success) {
        setNotifySuccess(true);
        setTimeout(() => setNotifySuccess(false), 4000);
        queryStatus();
      } else {
        setNotifyError(res.error || '发送失败');
      }
    } catch (err) {
      setNotifyError(err.message);
    } finally {
      setIsNotifying(false);
    }
  }, [selectedApp, queryStatus]);

  return {
    apps,
    selectedApp,
    setSelectedApp,
    config,
    versions,
    versionMeta,
    selectedVersion,
    setSelectedVersion,
    apkPreview,
    selectedChannels,
    toggleChannel,
    updateDesc,
    setUpdateDesc,
    activeTask,
    history,
    selectedFile,
    handleFileSelect,
    localVersion,
    setLocalVersion,
    submitLocalPublish,
    isLoading,
    isSubmitting,
    actionError,
    submitPublish,
    queryStatus,
    isQuerying,
    queryResults,
    queryError,
    sendWebhookNotify,
    isNotifying,
    notifyError,
    notifySuccess,
  };
}
