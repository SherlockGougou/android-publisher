import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { BIT_FILTERS, DOWNLOAD, VALID_CHANNELS } from '../constants';
import { formatTime, getBitType, getChannel } from '../utils';

export default function FileList({ version, files, fileMeta, onQrOpen }) {
    const [filter, setFilter] = useState('全部');
    const [selected, setSelected] = useState([]);
    const [loading, setLoading] = useState(false);
    const fileMetaForVersion = fileMeta[version] || {};

    const filteredFiles = useMemo(() => {
        return (filter === '全部' ? files : files.filter((f) => getBitType(f) === filter))
            .filter((f) => VALID_CHANNELS.includes(getChannel(f)))
            .slice()
            .sort((a, b) => {
                const channelDiff = getChannel(a).localeCompare(getChannel(b), 'zh-CN');
                if (channelDiff !== 0) return channelDiff;
                return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
            });
    }, [files, filter]);

    useEffect(() => {
        setSelected((prev) => prev.filter((item) => files.includes(item)));
    }, [files]);

    const isAllSelected = filteredFiles.length > 0 && filteredFiles.every((f) => selected.includes(f));

    function handleSelectAll() {
        setSelected((prev) =>
            isAllSelected
                ? prev.filter((item) => !filteredFiles.includes(item))
                : Array.from(new Set([...prev, ...filteredFiles])),
        );
    }

    function handleSelectOne(file) {
        setSelected((prev) =>
            prev.includes(file) ? prev.filter((item) => item !== file) : [...prev, file],
        );
    }

    function handleDownload(file) {
        window.open(`${DOWNLOAD}/${version}/${file}`);
    }

    function handleBatchDownload() {
        if (!selected.length || loading) return;
        setLoading(true);
        try {
            selected.forEach((file) => window.open(`${DOWNLOAD}/${version}/${file}`));
        } catch (err) {
            console.error('批量下载失败', err);
            alert('批量下载失败');
        } finally {
            setLoading(false);
        }
    }

    return (
        <>
            <div className="toolbar-top">
                <div className="filter-group" role="group" aria-label="位数筛选">
                    {BIT_FILTERS.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            className={clsx('filter-chip', { active: filter === option.value })}
                            onClick={() => setFilter(option.value)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
                <div className="toolbar-buttons">
                    <button
                        type="button"
                        className={clsx('action-button', { ghost: isAllSelected })}
                        onClick={handleSelectAll}
                    >
                        {isAllSelected ? '取消全选' : '全选当前筛选'}
                    </button>
                    <button
                        type="button"
                        className="action-button primary"
                        onClick={handleBatchDownload}
                        disabled={!selected.length || loading}
                    >
                        {loading ? '正在下载…' : `批量下载${selected.length ? ` (${selected.length})` : ''}`}
                    </button>
                </div>
            </div>

            <motion.section layout className="file-list" role="list">
                <div className="list-header" role="presentation">
                    <span className="col checkbox" aria-hidden="true" />
                    <span className="col name">文件</span>
                    <span className="col channel">渠道</span>
                    <span className="col arch">架构</span>
                    <span className="col updated">更新时间</span>
                    <span className="col actions" aria-hidden="true" />
                </div>
                <div role="list">
                    {filteredFiles.map((file) => {
                        const channel = getChannel(file);
                        const bit = getBitType(file);
                        const updatedAt = formatTime(fileMetaForVersion[file]);
                        const isChecked = selected.includes(file);
                        return (
                            <div
                                key={file}
                                role="listitem"
                                className={clsx('list-row', { selected: isChecked })}
                            >
                                <label className="checkbox">
                                    <input
                                        type="checkbox"
                                        checked={isChecked}
                                        onChange={() => handleSelectOne(file)}
                                    />
                                    <span aria-hidden="true" />
                                </label>
                                <div className="cell name">
                                    <p className="file-name" title={file}>{file}</p>
                                </div>
                                <div className="cell channel">
                                    <span className="chip">{channel}</span>
                                </div>
                                <div className="cell arch">
                                    <span className="arch-tag">{bit === '未知' ? '未识别' : `${bit}-bit`}</span>
                                </div>
                                <div className="cell updated">
                                    <span className="meta">{updatedAt}</span>
                                </div>
                                <div className="cell actions">
                                    <button type="button" className="icon-button" onClick={() => handleDownload(file)}>
                                        下载
                                    </button>
                                    <button type="button" className="icon-button" onClick={() => onQrOpen(file)}>
                                        二维码
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
                {!filteredFiles.length && (
                    <div className="empty-state">
                        <p>当前筛选暂时没有匹配的安装包。</p>
                    </div>
                )}
            </motion.section>
        </>
    );
}
