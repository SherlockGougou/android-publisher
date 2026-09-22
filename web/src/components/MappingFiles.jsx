import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { DOWNLOAD } from '../constants';
import { formatTime } from '../utils';

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function MappingFiles({ theme, onThemeChange }) {
    const [mappings, setMappings] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch('/api/mappings')
            .then((r) => r.json())
            .then((data) => {
                setMappings(data.mappings || []);
                setLoading(false);
            })
            .catch((err) => {
                console.error('获取 mapping 列表失败', err);
                setLoading(false);
            });
    }, []);

    function handleDownload(version) {
        window.open(`${DOWNLOAD}/${version}/mapping.txt`);
    }

    return (
        <>
            <header className="content-header">
                <div>
                    <p className="eyebrow">Mapping 管理</p>
                    <h2>Mapping 文件</h2>
                    <p className="helper-text">
                        各版本的 ProGuard mapping.txt 文件，下载后可上传至友盟进行崩溃日志还原。
                    </p>
                </div>
            </header>

            <motion.section layout className="file-list mapping-list" role="list">
                <div className="list-header" role="presentation">
                    <span className="col name">版本</span>
                    <span className="col size">文件大小</span>
                    <span className="col updated">更新时间</span>
                    <span className="col actions" aria-hidden="true" />
                </div>
                <div role="list">
                    {mappings.map((item) => (
                        <div key={item.version} role="listitem" className="list-row">
                            <div className="cell name">
                                <p className="file-name">{item.version}</p>
                            </div>
                            <div className="cell size">
                                <span className="meta">{formatFileSize(item.size)}</span>
                            </div>
                            <div className="cell updated">
                                <span className="meta">{formatTime(item.modifiedAt)}</span>
                            </div>
                            <div className="cell actions">
                                <button
                                    type="button"
                                    className="icon-button"
                                    onClick={() => handleDownload(item.version)}
                                >
                                    下载
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
                {!loading && !mappings.length && (
                    <div className="empty-state">
                        <p>未找到任何 mapping.txt 文件。</p>
                    </div>
                )}
                {loading && (
                    <div className="empty-state">
                        <p>加载中…</p>
                    </div>
                )}
            </motion.section>
        </>
    );
}
