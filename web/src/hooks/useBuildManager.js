import { useEffect, useRef, useState } from 'react';
import { BUILD_API } from '../constants';

const APPS_API = '/api/apps';

function sortTasks(tasks) {
    return [...tasks].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    );
}

function mergeTask(list, task) {
    const next = list.filter((item) => item.id !== task.id);
    next.unshift(task);
    return sortTasks(next).slice(0, 30);
}

async function request(url, options) {
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

export function useBuildManager() {
    const [apps, setApps] = useState([]);
    const [selectedApp, setSelectedApp] = useState('');
    const [isGitRepo, setIsGitRepo] = useState(true);
    const [branches, setBranches] = useState([]);
    const [branchMeta, setBranchMeta] = useState({});
    const [currentBranch, setCurrentBranch] = useState('');
    const [defaultBranch, setDefaultBranch] = useState('main');
    const [suggestedVersion, setSuggestedVersion] = useState('');
    const [suggestedUpdateLog, setSuggestedUpdateLog] = useState('');
    const [branchDefaultsRevision, setBranchDefaultsRevision] = useState(0);
    const [activeTask, setActiveTask] = useState(null);
    const [history, setHistory] = useState([]);
    const [selectedTaskId, setSelectedTaskId] = useState('');
    const [logs, setLogs] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isRefreshingBranches, setIsRefreshingBranches] = useState(false);
    const [actionError, setActionError] = useState('');
    const [reloadTick, setReloadTick] = useState(0);
    const hasHydratedBranchDefaults = useRef(false);
    const logBufferRef = useRef([]);
    const logRafRef = useRef(null);

    function applyBranchPayload(payload, { resetForm = false } = {}) {
        setIsGitRepo(payload.isGitRepo !== false);
        setBranches(payload.branches || []);
        setBranchMeta(payload.branchMeta || {});
        setCurrentBranch(payload.currentBranch || '');
        setDefaultBranch(payload.defaultBranch || 'main');
        setSuggestedVersion(payload.suggestedVersion || '');
        setSuggestedUpdateLog(payload.suggestedUpdateLog || '');

        if (resetForm || !hasHydratedBranchDefaults.current) {
            hasHydratedBranchDefaults.current = true;
            setBranchDefaultsRevision((value) => value + 1);
        }
    }

    useEffect(() => {
        let ignore = false;
        request(APPS_API)
            .then((payload) => {
                if (ignore) return;
                const list = payload?.data || [];
                setApps(list);
                if (list.length > 0) {
                    setSelectedApp((previous) => previous || list[0].applicationId);
                }
            })
            .catch(() => {});
        return () => {
            ignore = true;
        };
    }, []);

    // 切换应用时重新灌注表单默认值（分支/版本/更新日志）
    useEffect(() => {
        hasHydratedBranchDefaults.current = false;
    }, [selectedApp]);

    useEffect(() => {
        const timerId = window.setInterval(() => {
            setReloadTick((value) => value + 1);
        }, 15000);

        return () => window.clearInterval(timerId);
    }, []);

    useEffect(() => {
        if (!selectedApp) return undefined;
        let ignore = false;

        async function loadOverview() {
            try {
                const appParam = encodeURIComponent(selectedApp);
                const [branchPayload, activePayload, historyPayload] = await Promise.all([
                    request(`${BUILD_API}/branches?app=${appParam}`),
                    request(`${BUILD_API}/active`),
                    request(`${BUILD_API}/history`),
                ]);

                if (ignore) return;

                applyBranchPayload(branchPayload);
                setActiveTask(activePayload.task || null);
                setHistory(sortTasks(historyPayload.tasks || []));
                setActionError('');
            } catch (error) {
                if (!ignore) {
                    setActionError(error.message || '加载打包信息失败');
                }
            } finally {
                if (!ignore) {
                    setIsLoading(false);
                }
            }
        }

        loadOverview();

        return () => {
            ignore = true;
        };
    }, [reloadTick, selectedApp]);

    useEffect(() => {
        if (activeTask?.id && selectedTaskId !== activeTask.id) {
            setSelectedTaskId(activeTask.id);
            return;
        }

        if (!selectedTaskId && history.length) {
            setSelectedTaskId(history[0].id);
            return;
        }

        if (selectedTaskId && !activeTask?.id && !history.some((task) => task.id === selectedTaskId) && history.length) {
            setSelectedTaskId(history[0].id);
        }
    }, [activeTask, history, selectedTaskId]);

    useEffect(() => {
        if (!selectedTaskId) {
            setLogs([]);
            return undefined;
        }

        setLogs([]);
        logBufferRef.current = [];
        if (logRafRef.current) {
            cancelAnimationFrame(logRafRef.current);
            logRafRef.current = null;
        }
        const stream = new EventSource(`${BUILD_API}/${selectedTaskId}/stream`);

        const handleTask = (event) => {
            const task = JSON.parse(event.data);
            setHistory((previous) => mergeTask(previous, task));
            setActiveTask((previous) => (task.isActive ? task : previous?.id === task.id ? null : previous));
        };

        const flushLogBuffer = () => {
            logRafRef.current = null;
            const lines = logBufferRef.current.splice(0);
            if (lines.length) {
                setLogs((previous) => previous.concat(lines));
            }
        };

        const handleLog = (event) => {
            const payload = JSON.parse(event.data);
            logBufferRef.current.push(payload.line);
            if (!logRafRef.current) {
                logRafRef.current = requestAnimationFrame(flushLogBuffer);
            }
        };

        const handleEnd = () => {
            // Flush any remaining buffered lines before closing
            if (logRafRef.current) {
                cancelAnimationFrame(logRafRef.current);
                logRafRef.current = null;
            }
            flushLogBuffer();
            stream.close();
            setReloadTick((value) => value + 1);
        };

        const handleError = () => {
            stream.close();
        };

        stream.addEventListener('task', handleTask);
        stream.addEventListener('log', handleLog);
        stream.addEventListener('end', handleEnd);
        stream.onerror = handleError;

        return () => {
            stream.removeEventListener('task', handleTask);
            stream.removeEventListener('log', handleLog);
            stream.removeEventListener('end', handleEnd);
            stream.close();
            if (logRafRef.current) {
                cancelAnimationFrame(logRafRef.current);
                logRafRef.current = null;
            }
        };
    }, [selectedTaskId]);

    async function startBuild(payload) {
        setIsSubmitting(true);
        setActionError('');
        try {
            const response = await request(BUILD_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, appId: selectedApp }),
            });
            const task = response.task;
            setActiveTask(task);
            setHistory((previous) => mergeTask(previous, task));
            setSelectedTaskId(task.id);
            return task;
        } catch (error) {
            setActionError(error.message || '启动任务失败');
            throw error;
        } finally {
            setIsSubmitting(false);
        }
    }

    async function cancelBuild(taskId) {
        setActionError('');
        try {
            const response = await request(`${BUILD_API}/${taskId}/cancel`, {
                method: 'POST',
            });
            const task = response.task;
            setHistory((previous) => mergeTask(previous, task));
            setActiveTask(task.isActive ? task : null);
            return task;
        } catch (error) {
            setActionError(error.message || '终止任务失败');
            throw error;
        }
    }

    async function refreshBranches() {
        setIsRefreshingBranches(true);
        setActionError('');
        try {
            const payload = await request(`${BUILD_API}/branches?refresh=1&app=${encodeURIComponent(selectedApp)}`);
            applyBranchPayload(payload, { resetForm: true });
            return payload;
        } catch (error) {
            setActionError(error.message || '刷新分支列表失败');
            throw error;
        } finally {
            setIsRefreshingBranches(false);
        }
    }

    function refresh() {
        setReloadTick((value) => value + 1);
    }

    const selectedTask =
        (selectedTaskId === activeTask?.id ? activeTask : null) ||
        history.find((task) => task.id === selectedTaskId) ||
        activeTask ||
        history[0] ||
        null;

    return {
        apps,
        selectedApp,
        setSelectedApp,
        isGitRepo,
        branches,
        branchMeta,
        currentBranch,
        defaultBranch,
        suggestedVersion,
        suggestedUpdateLog,
        branchDefaultsRevision,
        activeTask,
        history,
        selectedTask,
        selectedTaskId,
        logs,
        isLoading,
        isSubmitting,
        isRefreshingBranches,
        actionError,
        setSelectedTaskId,
        startBuild,
        cancelBuild,
        refreshBranches,
        refresh,
    };
}