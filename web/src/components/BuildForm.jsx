import { useEffect, useState } from 'react';
import { formatTime } from '../utils';

export default function BuildForm({
    apps,
    selectedApp,
    onAppChange,
    isGitRepo,
    branches,
    branchMeta,
    defaultBranch,
    suggestedVersion,
    suggestedUpdateLog,
    defaultsRevision,
    disabled,
    isSubmitting,
    isRefreshingBranches,
    onRefreshBranches,
    onSubmit,
}) {
    const [form, setForm] = useState({
        branch: '',
        version: '',
        updateLog: '',
    });
    const [errors, setErrors] = useState({});

    function getBranchUpdatedLabel(branch) {
        const updatedAt = branchMeta?.[branch]?.updatedAt;
        return updatedAt ? formatTime(updatedAt) : '未知';
    }

    useEffect(() => {
        if (!defaultsRevision) return;

        setForm((previous) => ({
            branch: defaultBranch || previous.branch || branches[0] || '',
            version: suggestedVersion || previous.version,
            updateLog: suggestedUpdateLog || previous.updateLog,
        }));
        setErrors({});
    }, [defaultBranch, suggestedVersion, suggestedUpdateLog, defaultsRevision]);

    function handleRefreshBranches() {
        onRefreshBranches?.().catch(() => {});
    }

    function handleChange(key, value) {
        setForm((previous) => ({ ...previous, [key]: value }));
        setErrors((previous) => ({ ...previous, [key]: '' }));
    }

    function handleSubmit(event) {
        event.preventDefault();
        const nextErrors = {};

        if (isGitRepo && !form.branch) {
            nextErrors.branch = '请选择一个分支';
        }
        if (!form.version.trim()) {
            nextErrors.version = '请输入版本号';
        } else if (/[\\/]/.test(form.version)) {
            nextErrors.version = '版本号不能包含路径分隔符';
        }

        if (Object.keys(nextErrors).length) {
            setErrors(nextErrors);
            return;
        }

        onSubmit({
            branch: form.branch,
            version: form.version.trim(),
            updateLog: form.updateLog.trim(),
        });
    }

    const selectedBranchUpdatedLabel = form.branch ? getBranchUpdatedLabel(form.branch) : '';

    return (
        <section className="build-card build-form-card">
            <div className="panel-heading">
                <div>
                    <p className="eyebrow">Build Form</p>
                    <h3>新建打包任务</h3>
                </div>
                <span className="panel-hint">开始前会强制丢弃仓库中的本地修改</span>
            </div>

            <form className="build-form" onSubmit={handleSubmit}>
                <label className="form-field full-width">
                    <span>应用</span>
                    <div className="branch-select-wrap">
                        <select
                            className="branch-select"
                            value={selectedApp}
                            onChange={(event) => onAppChange?.(event.target.value)}
                            disabled={disabled}
                        >
                            {apps.map((app) => (
                                <option key={app.applicationId} value={app.applicationId}>
                                    {app.name ? `${app.name}（${app.applicationId}）` : app.applicationId}
                                </option>
                            ))}
                        </select>
                        <span className="branch-select-arrow" aria-hidden="true" />
                    </div>
                </label>

                {isGitRepo ? (
                <label className="form-field">
                    <span>目标分支</span>
                    <div className="branch-field-row">
                        <div className="branch-select-wrap">
                            <select
                                className="branch-select"
                                value={form.branch}
                                onChange={(event) => handleChange('branch', event.target.value)}
                                disabled={disabled}
                            >
                                <option value="">请选择分支</option>
                                {branches.map((branch) => (
                                    <option key={branch} value={branch}>
                                        {`${branch} · ${getBranchUpdatedLabel(branch)}`}
                                    </option>
                                ))}
                            </select>
                            <span className="branch-select-arrow" aria-hidden="true" />
                        </div>
                        <button
                            type="button"
                            className="action-button ghost compact"
                            onClick={handleRefreshBranches}
                            disabled={isRefreshingBranches}
                        >
                            {isRefreshingBranches ? '刷新中…' : '刷新分支'}
                        </button>
                    </div>
                    {form.branch && <small className="field-hint">最新提交时间：{selectedBranchUpdatedLabel}</small>}
                    {errors.branch && <small className="field-error">{errors.branch}</small>}
                </label>
                ) : (
                <label className="form-field">
                    <span>目标分支</span>
                    <small className="field-hint">该应用的构建项目不是 Git 仓库，将跳过分支同步、直接执行构建脚本</small>
                </label>
                )}

                <label className="form-field">
                    <span>版本号</span>
                    <input
                        type="text"
                        value={form.version}
                        onChange={(event) => handleChange('version', event.target.value)}
                        placeholder="默认读取目标分支 app/build.gradle"
                        disabled={disabled}
                    />
                    {errors.version && <small className="field-error">{errors.version}</small>}
                </label>

                <label className="form-field full-width">
                    <span>更新日志</span>
                    <textarea
                        value={form.updateLog}
                        onChange={(event) => handleChange('updateLog', event.target.value)}
                        placeholder="默认根据目标分支最近提交历史生成"
                        rows={6}
                        disabled={disabled}
                    />
                </label>

                <div className="form-actions">
                    <button type="submit" className="action-button primary" disabled={disabled || isSubmitting}>
                        {isSubmitting ? '正在创建任务…' : '开始打包'}
                    </button>
                </div>
            </form>
        </section>
    );
}