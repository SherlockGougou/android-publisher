import { useEffect, useRef } from 'react';
import ThemeSwitcher from './ThemeSwitcher';
import BuildForm from './BuildForm';
import BuildLogViewer from './BuildLogViewer';
import { useBuildManager } from '../hooks/useBuildManager';
import { BUILD_STATUS_LABELS, BUILD_STATUS_TONES } from '../constants';
import { formatDuration, formatTaskTime } from '../utils';

function HealthItem({ label, value, ok = true }) {
    return (
        <div className="health-item">
            <span>{label}</span>
            <strong className={ok ? '' : 'danger'}>{value}</strong>
        </div>
    );
}

export default function BuildManager({ theme, onThemeChange, versions, onOpenArtifacts, onArtifactsRefresh }) {
    const {
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
        selectedTask,
        logs,
        isLoading,
        isSubmitting,
        isRefreshingBranches,
        actionError,
        startBuild,
        cancelBuild,
        refreshBranches,
        refresh,
    } = useBuildManager();
    const lastSyncedSuccessId = useRef('');
    const canOpenArtifacts = Boolean(selectedTask?.artifactVersion && versions.includes(selectedTask.artifactVersion));
    const selectedTone = BUILD_STATUS_TONES[selectedTask?.status] || 'muted';

    useEffect(() => {
        if (selectedTask?.status === 'success' && selectedTask.id !== lastSyncedSuccessId.current) {
            lastSyncedSuccessId.current = selectedTask.id;
            onArtifactsRefresh?.();
        }
    }, [onArtifactsRefresh, selectedTask]);

    async function handleSubmit(payload) {
        await startBuild(payload);
    }

    async function handleCancel() {
        if (!activeTask) return;
        await cancelBuild(activeTask.id);
    }

    return (
        <>
            <header className="content-header">
                <div>
                    <p className="eyebrow">Build Console</p>
                    <h2>本地打包管理</h2>
                    <p className="helper-text">选择应用与分支、填写版本号与更新日志，在这台机器上直接发起 Android 打包。</p>
                </div>
                <ThemeSwitcher theme={theme} onChange={onThemeChange} />
            </header>

            {actionError && (
                <div className="build-alert danger">
                    <strong>操作失败</strong>
                    <span>{actionError}</span>
                </div>
            )}

            <div className="build-grid">
                <div className="build-top-grid">
                    <BuildForm
                        apps={apps}
                        selectedApp={selectedApp}
                        onAppChange={setSelectedApp}
                        isGitRepo={isGitRepo}
                        branches={branches}
                        branchMeta={branchMeta}
                        defaultBranch={defaultBranch || currentBranch || 'main'}
                        suggestedVersion={suggestedVersion}
                        suggestedUpdateLog={suggestedUpdateLog}
                        defaultsRevision={branchDefaultsRevision}
                        disabled={Boolean(activeTask)}
                        isSubmitting={isSubmitting}
                        isRefreshingBranches={isRefreshingBranches}
                        onRefreshBranches={refreshBranches}
                        onSubmit={handleSubmit}
                    />

                    <section className="build-card task-card">
                        <div className="panel-heading">
                            <div>
                                <p className="eyebrow">Task Status</p>
                                <h3>{selectedTask ? (selectedTask.id === activeTask?.id ? '当前任务详情' : '最近任务详情') : '等待任务'}</h3>
                            </div>
                            <div className="task-actions">
                                <button type="button" className="action-button ghost" onClick={refresh}>
                                    刷新状态
                                </button>
                                <button
                                    type="button"
                                    className="action-button"
                                    onClick={handleCancel}
                                    disabled={!activeTask}
                                >
                                    终止任务
                                </button>
                                <button
                                    type="button"
                                    className="action-button primary"
                                    onClick={() => onOpenArtifacts(selectedTask.artifactVersion)}
                                    disabled={!canOpenArtifacts}
                                >
                                    查看产物
                                </button>
                            </div>
                        </div>

                        {selectedTask ? (
                            <>
                                <div className="task-topline">
                                    <div>
                                        <strong>{selectedTask.version}</strong>
                                        <p>{selectedTask.branch}</p>
                                    </div>
                                    <span className={`status-pill ${selectedTone}`}>
                                        {BUILD_STATUS_LABELS[selectedTask.status] || selectedTask.status}
                                    </span>
                                </div>

                                <div className="progress-rail">
                                    <div className="progress-value" style={{ width: `${selectedTask.progress || 0}%` }} />
                                </div>
                                <div className="task-meta-grid">
                                    <HealthItem label="当前阶段" value={selectedTask.currentStageText || '-'} />
                                    <HealthItem label="开始时间" value={formatTaskTime(selectedTask.startedAt)} />
                                    <HealthItem label="耗时" value={formatDuration(selectedTask.startedAt, selectedTask.endedAt)} />
                                    <HealthItem label="Commit" value={selectedTask.commitHash || '-'} />
                                    <HealthItem label="提交说明" value={selectedTask.commitMessage || '-'} />
                                    <HealthItem label="错误原因" value={selectedTask.error || '-'} ok={!selectedTask.error} />
                                </div>
                            </>
                        ) : (
                            <div className="empty-state slim">
                                <p>{isLoading ? '正在加载任务信息…' : '当前没有任务，填写表单后可以立即开始打包。'}</p>
                            </div>
                        )}
                    </section>
                </div>

                <BuildLogViewer logs={logs} task={selectedTask} />
            </div>
        </>
    );
}