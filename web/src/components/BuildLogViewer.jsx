import { useEffect, useMemo, useRef } from 'react';

const MAX_VISIBLE_LINES = 5000;

export default function BuildLogViewer({ logs, task }) {
    const viewportRef = useRef(null);
    const scrollRafRef = useRef(null);

    const trimmed = logs.length > MAX_VISIBLE_LINES;
    const visibleLogs = trimmed ? logs.slice(-MAX_VISIBLE_LINES) : logs;
    const totalCount = logs.length;

    const statusLabel = totalCount
        ? `${totalCount} 行日志`
        : task
            ? '等待日志输出'
            : '未选择任务';

    // Scroll to bottom via RAF to avoid forced layout reflow on every update
    useEffect(() => {
        if (!viewportRef.current) return;
        if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = requestAnimationFrame(() => {
            scrollRafRef.current = null;
            if (viewportRef.current) {
                viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
            }
        });
        return () => {
            if (scrollRafRef.current) {
                cancelAnimationFrame(scrollRafRef.current);
                scrollRafRef.current = null;
            }
        };
    }, [logs]);

    const lineNodes = useMemo(() => (
        visibleLogs.map((line, index) => {
            const lineNumber = trimmed ? totalCount - MAX_VISIBLE_LINES + index + 1 : index + 1;
            return (
                <div key={lineNumber} className="log-line">
                    <span className="log-line-number" aria-hidden="true">{String(lineNumber).padStart(4, '0')}</span>
                    <span className="log-line-text">{line}</span>
                </div>
            );
        })
    ), [visibleLogs, trimmed, totalCount]);

    return (
        <section className="build-card log-card">
            <div className="panel-heading compact">
                <div>
                    <p className="eyebrow">Live Logs</p>
                    <h3>实时日志</h3>
                </div>
                <div className="log-header-meta">
                    {task && <span className="log-meta">{task.version} / {task.branch}</span>}
                    <span className={`log-meta ${totalCount ? '' : 'muted'}`.trim()}>{statusLabel}</span>
                </div>
            </div>

            <div ref={viewportRef} className="log-viewport">
                {totalCount ? (
                    <>
                        {trimmed && (
                            <div className="log-trim-notice">
                                &#8593; 仅显示最后 {MAX_VISIBLE_LINES} 行（共 {totalCount} 行）
                            </div>
                        )}
                        {lineNodes}
                    </>
                ) : (
                    <div className="log-empty-state">
                        <span className="log-empty-icon" aria-hidden="true">›_</span>
                        <strong>{task ? '当前任务暂时还没有日志输出' : '选择一个任务后将在这里显示日志'}</strong>
                        <p>
                            {task
                                ? '打包开始后，这里会持续滚动显示构建过程中的完整日志。'
                                : '创建新任务后，或等待当前任务启动后自动查看日志。'}
                        </p>
                    </div>
                )}
            </div>
        </section>
    );
}