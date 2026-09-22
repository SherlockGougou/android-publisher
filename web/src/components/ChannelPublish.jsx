import { useEffect, useState } from 'react';
import { useChannelPublish } from '../hooks/useChannelPublish';
import ThemeSwitcher from './ThemeSwitcher';
import { formatTime, formatRelativeTime } from '../utils';

const STATE_LABELS = {
  Online: '已上线',
  UnderReview: '审核中',
  Rejected: '被拒绝',
  Unknown: '未知',
};

const STATUS_LABELS = {
  pending: '等待中',
  running: '上传中',
  success: '成功',
  failed: '失败',
};

const STATUS_TONES = {
  pending: 'muted',
  running: 'info',
  success: 'success',
  failed: 'danger',
};

const STATE_TONES = {
  Online: 'success',
  UnderReview: 'info',
  Rejected: 'danger',
  Unknown: 'muted',
};

function ChannelCard({ name, result }) {
  const tone = STATUS_TONES[result?.status] || 'muted';
  const pct = result?.progress || 0;
  return (
    <div className={`channel-card tone-${tone}`}>
      <div className="channel-card-header">
        <span className="channel-name">{name}</span>
        <span className={`status-pill ${tone}`}>
          {STATUS_LABELS[result?.status] || '—'}
        </span>
      </div>
      {result?.apkName && (
        <div className="channel-apk-name" title={result.apkPath}>{result.apkName}</div>
      )}
      {result?.status === 'running' && (
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      {result?.message && (
        <div className={`channel-message ${result.status === 'failed' ? 'danger' : ''}`}>
          {result.message}
        </div>
      )}
    </div>
  );
}

function TaskHistoryItem({ task }) {
  const tone = task.status === 'success' ? 'success' : task.status === 'running' ? 'info' : 'danger';
  const elapsed = task.endTime
    ? `${Math.round((task.endTime - task.startTime) / 1000)}s`
    : '进行中';
  return (
    <div className={`history-item tone-${tone}`}>
      <div className="history-topline">
        <span style={{ fontWeight: 600 }}>v{task.version}</span>
        <span className={`status-pill ${tone}`} style={{ fontSize: '0.72rem', padding: '4px 10px' }}>
          {STATUS_LABELS[task.status] || task.status}
        </span>
        <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>{elapsed}</span>
      </div>
      <div className="history-channels">
        {task.channelNames.map((n) => {
          const r = task.channelResults?.[n];
          const ct = STATUS_TONES[r?.status] || 'muted';
          return (
            <span key={n} className={`channel-pill pill-${ct}`}>{n}</span>
          );
        })}
      </div>
    </div>
  );
}

function QueryCard({ name, result, isLoading }) {
  if (!result && isLoading) {
    return (
      <div className="channel-query-card">
        <div className="channel-query-card-name">{name}</div>
        <span className="status-pill muted" style={{ alignSelf: 'flex-start', fontSize: '0.74rem' }}>查询中…</span>
      </div>
    );
  }
  if (!result) return null;
  if (result.error) {
    return (
      <div className="channel-query-card">
        <div className="channel-query-card-name">{name}</div>
        <span className="status-pill danger" style={{ alignSelf: 'flex-start', fontSize: '0.74rem' }}>查询失败</span>
        <div className="channel-query-card-error">{result.error}</div>
      </div>
    );
  }
  const tone = STATE_TONES[result.state] || 'muted';
  return (
    <div className="channel-query-card">
      <div className="channel-query-card-name">{name}</div>
      <span className={`status-pill ${tone}`} style={{ alignSelf: 'flex-start', fontSize: '0.74rem' }}>
        {STATE_LABELS[result.state] || result.state}
      </span>
      {result.versionName && (
        <div className="channel-query-card-version">
          {result.versionName}{result.versionCode ? ` (${result.versionCode})` : ''}
        </div>
      )}
    </div>
  );
}

export default function ChannelPublish({ theme, onThemeChange }) {
  const {
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
    isLoading,
    isSubmitting,
    actionError,
    submitPublish,
    selectedFile,
    handleFileSelect,
    localVersion,
    setLocalVersion,
    submitLocalPublish,
    queryStatus,
    isQuerying,
    queryResults,
    queryError,
    sendWebhookNotify,
    isNotifying,
    notifyError,
    notifySuccess,
  } = useChannelPublish();

  // 发布来源：'library' 从版本库选择已归档版本；'upload' 直接上传本机 APK
  const [sourceMode, setSourceMode] = useState('library');
  const isUploadMode = sourceMode === 'upload';

  const isRunning = activeTask?.status === 'running';
  const canSubmit = !isSubmitting && !isRunning && selectedVersion && selectedChannels.size > 0;
  const canSubmitLocal = !isSubmitting && !isRunning && !!selectedFile && selectedChannels.size > 0;

  // 版本库为空（例如全新部署）时，自动切到本地上传模式，避免无版本可选
  useEffect(() => {
    if (selectedApp && versions.length === 0) {
      setSourceMode('upload');
    }
  }, [selectedApp, versions.length]);

  const previewMap = {};
  for (const p of apkPreview) {
    previewMap[p.channelName] = p;
  }

  const enabledChannels = (config?.channels || []).filter(ch => ch.enable);
  const hasQueryData = Object.keys(queryResults).length > 0;

  return (
    <div className="content-area">
      <header className="content-header">
        <div>
          <p className="eyebrow">渠道发布</p>
          <h2>多市场上架</h2>
          <p className="helper-text">选择版本和渠道，一键提交到各应用市场。</p>
        </div>
        <ThemeSwitcher theme={theme} onChange={onThemeChange} />
      </header>

      {actionError && (
        <div className="build-alert" style={{ borderColor: 'rgba(255,108,122,0.3)', marginBottom: 20 }}>
          <span style={{ color: '#ff8b99' }}>{actionError}</span>
        </div>
      )}

      {/* 应用切换 */}
      {apps.length > 1 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>应用</span>
            <div style={{ position: 'relative' }}>
              <select
                className="branch-select"
                value={selectedApp}
                onChange={(e) => setSelectedApp(e.target.value)}
                style={{ borderRadius: 16, border: '1px solid var(--border-soft)', background: 'rgba(255,255,255,0.06)', color: 'var(--text-primary)', padding: '10px 42px 10px 16px', fontSize: '0.92rem', appearance: 'none', minWidth: 180 }}
              >
                {apps.map((app) => (
                  <option key={app.applicationId} value={app.applicationId}>
                    {app.name} ({app.applicationId})
                  </option>
                ))}
              </select>
              <span className="branch-select-arrow" />
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <div style={{ padding: '40px 0', color: 'var(--text-muted)', textAlign: 'center' }}>加载中...</div>
      ) : (
        <>
          {/* ── 渠道状态（顶部全宽，自动加载）── */}
          {enabledChannels.length > 0 && (
            <section className="channel-status-section">
              <div className="channel-query-toolbar">
                <h3 className="panel-title" style={{ margin: 0 }}>渠道状态</h3>
                <button
                  className="action-button"
                  onClick={queryStatus}
                  disabled={isQuerying}
                  style={{ padding: '8px 18px', fontSize: '0.88rem' }}
                >
                  {isQuerying ? '刷新中…' : '刷新'}
                </button>
                <button
                  className="action-button channel-notify-btn"
                  onClick={sendWebhookNotify}
                  disabled={isNotifying || isQuerying}
                >
                  {isNotifying ? '发送中…' : '📬 推送通知'}
                </button>
                {notifySuccess && (
                  <span style={{ color: '#66dd96', fontSize: '0.82rem' }}>✓ 已发送</span>
                )}
                {notifyError && (
                  <span style={{ color: '#ff8b99', fontSize: '0.82rem' }}>{notifyError}</span>
                )}
                {queryError && (
                  <span style={{ color: '#ff8b99', fontSize: '0.82rem' }}>{queryError}</span>
                )}
              </div>
              <div className="channel-query-grid" style={{ marginTop: 16 }}>
                {enabledChannels.map((ch) => (
                  <QueryCard
                    key={ch.name}
                    name={ch.name}
                    result={queryResults[ch.name]}
                    isLoading={isQuerying && !hasQueryData}
                  />
                ))}
              </div>
            </section>
          )}

          {/* ── 发布配置 + 当前任务 ── */}
          {config && (
          <div className="channel-publish-body" style={{ marginTop: 24 }}>
            {/* 左侧：发布表单 */}
            <section className="channel-form-panel">
              <h3 className="panel-title" style={{ marginBottom: 4 }}>发布配置</h3>

              {/* 发布来源切换：版本库模式 / 本地上传模式 */}
              <div className="form-field">
                <span>发布来源</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className={`action-button compact ${isUploadMode ? 'ghost' : 'primary'}`}
                    onClick={() => setSourceMode('library')}
                    disabled={isRunning}
                  >
                    从版本库选择
                  </button>
                  <button
                    type="button"
                    className={`action-button compact ${isUploadMode ? 'primary' : 'ghost'}`}
                    onClick={() => setSourceMode('upload')}
                    disabled={isRunning}
                  >
                    上传新 APK
                  </button>
                </div>
              </div>

              {isUploadMode ? (
                <>
                  {/* 本地上传：选择本机 APK 文件 */}
                  <div className="form-field">
                    <span>APK 文件</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 16, border: '1px dashed var(--border-soft)', cursor: 'pointer', background: 'rgba(255,255,255,0.04)' }}>
                      <input
                        type="file"
                        accept=".apk"
                        style={{ display: 'none' }}
                        onChange={(e) => handleFileSelect(e.target.files?.[0] || null)}
                      />
                      <span style={{ fontSize: '0.95rem', color: selectedFile ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {selectedFile
                          ? `${selectedFile.name}（${(selectedFile.size / 1024 / 1024).toFixed(1)} MB）`
                          : '点击选择本机 APK 文件...'}
                      </span>
                    </label>
                  </div>

                  <div className="form-field">
                    <span>版本号（已从文件名解析，可修改）</span>
                    <input
                      type="text"
                      value={localVersion}
                      onChange={(e) => setLocalVersion(e.target.value)}
                      placeholder="如 2.4.6"
                      disabled={isRunning}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '14px 16px', borderRadius: 16, border: '1px solid var(--border-soft)', background: 'rgba(255,255,255,0.06)', color: 'var(--text-primary)', fontSize: '0.96rem' }}
                    />
                  </div>
                </>
              ) : (
                <div className="form-field">
                  <span>目标版本</span>
                  <div style={{ position: 'relative' }}>
                    <select
                      className="branch-select"
                      value={selectedVersion}
                      onChange={(e) => setSelectedVersion(e.target.value)}
                      disabled={isRunning}
                      style={{ width: '100%', borderRadius: 16, border: '1px solid var(--border-soft)', background: 'rgba(255,255,255,0.06)', color: 'var(--text-primary)', padding: '14px 42px 14px 16px', fontSize: '0.96rem', boxSizing: 'border-box', appearance: 'none' }}
                    >
                      {versions.length === 0 && <option value="">暂无版本</option>}
                      {versions.map((v) => {
                        const updatedAt = versionMeta?.[v]?.latestModified;
                        const label = updatedAt ? `${v} · ${formatRelativeTime(updatedAt)}` : v;
                        return (
                          <option key={v} value={v} title={updatedAt ? `构建时间：${formatTime(updatedAt)}` : undefined}>
                            {label}
                          </option>
                        );
                      })}
                    </select>
                    <span className="branch-select-arrow" />
                  </div>
                </div>
              )}

              <div className="form-field">
                <span>发布渠道</span>
                <div className="channel-checkboxes">
                  {(config?.channels || []).map((ch) => {
                    const preview = previewMap[ch.name];
                        const hasApk = isUploadMode ? true : preview?.apkPath;
                    return (
                      <label
                        key={ch.name}
                        className={`channel-checkbox-item ${!hasApk ? 'no-apk' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedChannels.has(ch.name)}
                          onChange={() => toggleChannel(ch.name)}
                          disabled={isRunning || !ch.enable}
                        />
                        <span className="channel-checkbox-name">{ch.name}</span>
                        {isUploadMode ? (
                          <span className="channel-apk-hint">本地上传</span>
                        ) : preview?.apkName ? (
                          <span className="channel-apk-hint" title={preview.apkPath}>{preview.apkName}</span>
                        ) : (
                          <span className="channel-apk-hint missing">未找到 APK</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="form-field">
                <span>更新说明</span>
                <textarea
                  rows={5}
                  value={updateDesc}
                  onChange={(e) => setUpdateDesc(e.target.value)}
                  placeholder="请输入本次版本的更新说明..."
                  disabled={isRunning}
                />
              </div>

              <div className="form-actions">
                <button
                  className="action-button primary"
                  onClick={isUploadMode ? submitLocalPublish : submitPublish}
                  disabled={isUploadMode ? !canSubmitLocal : !canSubmit}
                >
                  {isSubmitting ? '提交中...' : isRunning ? '发布中...' : isUploadMode ? '上传并发布' : '开始发布'}
                </button>
              </div>
            </section>

            {/* 右侧：当前任务进度 */}
            <section className="channel-progress-panel">
              <h3 className="panel-title" style={{ marginBottom: 4 }}>当前任务</h3>
              {activeTask ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>v{activeTask.version}</span>
                    <span className={`status-pill ${STATUS_TONES[activeTask.status] || 'muted'}`} style={{ fontSize: '0.76rem' }}>
                      {STATUS_LABELS[activeTask.status] || activeTask.status}
                    </span>
                  </div>
                  <div className="channel-cards">
                    {(activeTask.channelNames || []).map((name) => (
                      <ChannelCard
                        key={name}
                        name={name}
                        result={activeTask.channelResults?.[name]}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>暂无进行中的任务</div>
              )}
            </section>
          </div>
          )}

          {/* ── 历史记录 ── */}
          {config && history.length > 0 && (
            <section style={{ marginTop: 28 }}>
              <h3 className="panel-title">发布历史</h3>
              <div className="history-list">
                {history.map((task) => (
                  <TaskHistoryItem key={task.taskId} task={task} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

