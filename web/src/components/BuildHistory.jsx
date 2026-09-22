import clsx from 'clsx';
import { BUILD_STATUS_LABELS, BUILD_STATUS_TONES } from '../constants';
import { formatDuration, formatTaskTime } from '../utils';

export default function BuildHistory({ activeTaskId, selectedTaskId, tasks, onSelect }) {
    return (
        <section className="build-card history-card">
            <div className="panel-heading compact">
                <div>
                    <p className="eyebrow">Recent Tasks</p>
                    <h3>最近任务</h3>
                </div>
            </div>

            <div className="history-list">
                {tasks.length ? (
                    tasks.map((task) => {
                        const tone = BUILD_STATUS_TONES[task.status] || 'muted';
                        return (
                            <button
                                key={task.id}
                                type="button"
                                className={clsx('history-item', {
                                    active: selectedTaskId === task.id,
                                })}
                                onClick={() => onSelect(task.id)}
                            >
                                <div className="history-topline">
                                    <strong>{task.version}</strong>
                                    <span className={clsx('status-pill', tone)}>
                                        {BUILD_STATUS_LABELS[task.status] || task.status}
                                    </span>
                                </div>
                                <p>{task.branch}</p>
                                <p>{formatTaskTime(task.createdAt)}</p>
                                <p>{formatDuration(task.startedAt, task.endedAt)}</p>
                                {task.commitHash && <p>Commit {task.commitHash}</p>}
                                {activeTaskId === task.id && <span className="history-running">运行中</span>}
                            </button>
                        );
                    })
                ) : (
                    <div className="empty-state slim">
                        <p>还没有构建历史。</p>
                    </div>
                )}
            </div>
        </section>
    );
}