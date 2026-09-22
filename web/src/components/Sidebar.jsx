import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';

const VIEW_TO_PATH = {
    distribution: '/distribution',
    build: '/build',
    channelPublish: '/channel-publish',
    mappingFiles: '/mapping-files',
};

const FEATURES = [
    { value: 'distribution', title: '分发中心', description: '浏览已有 APK 产物' },
    { value: 'build', title: '打包管理', description: '发起并监控本地打包' },
    { value: 'channelPublish', title: '渠道发布', description: '一键上架各大应用市场' },
    { value: 'mappingFiles', title: 'Mapping 文件', description: '管理各版本 mapping.txt' },
];

export default function Sidebar({ currentView, onViewChange, versions, version, onVersionChange }) {
    const [open, setOpen] = useState(false);

    // 浏览器前进/后退时收起抽屉
    useEffect(() => {
        function onPopState() {
            setOpen(false);
        }
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
    }, []);

    function close() {
        setOpen(false);
    }

    function handleFeatureClick(feature) {
        onViewChange(feature.value);
        close();
    }

    function handleVersionClick(item) {
        onVersionChange(item);
        close();
    }

    return (
        <>
            <div className="mobile-topbar">
                <button
                    type="button"
                    className="mobile-menu-btn"
                    aria-label="打开菜单"
                    onClick={() => setOpen(true)}
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="3" y1="6" x2="21" y2="6" />
                        <line x1="3" y1="12" x2="21" y2="12" />
                        <line x1="3" y1="18" x2="21" y2="18" />
                    </svg>
                </button>
                <span className="mobile-topbar-title">Android Publisher</span>
            </div>

            {open && <div className="sidebar-backdrop" onClick={close} />}

            <aside className={clsx('sidebar', { 'sidebar--open': open })}>
                <div className="sidebar-header">
                    <motion.img
                        src="/favicon.svg"
                        alt="Android Publisher"
                        className="brand-mark"
                        whileHover={{ rotate: 360 }}
                        transition={{ duration: 0.6, ease: 'easeInOut' }}
                    />
                    <div>
                        <h1>Android Publisher</h1>
                        <p>多应用打包与渠道发布</p>
                    </div>
                </div>
                <div className="sidebar-section">
                    <span className="section-title">功能</span>
                    <div className="feature-list">
                        {FEATURES.map((feature) => (
                            <a
                                key={feature.value}
                                href={VIEW_TO_PATH[feature.value]}
                                className={clsx('feature-item', { active: currentView === feature.value })}
                                onClick={(e) => {
                                    e.preventDefault();
                                    handleFeatureClick(feature);
                                }}
                            >
                                <strong>{feature.title}</strong>
                                <span>{feature.description}</span>
                            </a>
                        ))}
                    </div>
                </div>
                <div className="sidebar-section">
                    <span className="section-title">版本号</span>
                    <div className="version-list" role="list">
                        {versions.map((item) => (
                            <a
                                key={item}
                                href={'/distribution/' + encodeURIComponent(item)}
                                className={clsx('version-item', { active: item === version })}
                                onClick={(e) => {
                                    e.preventDefault();
                                    handleVersionClick(item);
                                }}
                            >
                                <span>{item}</span>
                                {item === versions[0] && <span className="badge">Latest</span>}
                            </a>
                        ))}
                    </div>
                </div>
            </aside>
        </>
    );
}
