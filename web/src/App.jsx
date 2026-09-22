import { useState, useEffect } from 'react';
import { useTheme } from './hooks/useTheme';
import { useApkData } from './hooks/useApkData';
import { useRouting } from './hooks/useRouting';
import Sidebar from './components/Sidebar';
import FileList from './components/FileList';
import ThemeSwitcher from './components/ThemeSwitcher';
import QrModal from './components/QrModal';
import BuildManager from './components/BuildManager';
import ChannelPublish from './components/ChannelPublish';
import MappingFiles from './components/MappingFiles';

export default function App() {
    const { theme, setTheme } = useTheme();
    const { versions, version, setVersion, files, fileMeta, refresh } = useApkData();
    const { view: currentView, urlVersion, navigate, replaceVersion } = useRouting();
    const [qrFile, setQrFile] = useState(null);

    // URL 中携带版本时，同步到 useApkData；版本列表加载完后也做一次对齐
    useEffect(() => {
        if (!versions.length) return;
        const target = urlVersion && versions.includes(urlVersion) ? urlVersion : versions[0];
        if (target && target !== version) {
            setVersion(target);
        }
        // 若 URL 没有版本段，用 replaceState 补上当前版本，保持 URL 完整
        if (currentView === 'distribution' && !urlVersion && target) {
            replaceVersion(target);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [versions, urlVersion]);

    function handleOpenArtifacts(targetVersion) {
        if (!targetVersion) return;
        setVersion(targetVersion);
        navigate('distribution', targetVersion);
    }

    function handleSidebarVersionChange(targetVersion) {
        if (!targetVersion) return;
        setVersion(targetVersion);
        navigate('distribution', targetVersion);
    }

    function handleViewChange(newView) {
        if (newView === 'distribution') {
            navigate('distribution', version || null);
        } else {
            navigate(newView);
        }
    }

    return (
        <div className="app-shell">
            <div className="ambient-gradient" aria-hidden="true" />

            <Sidebar
                currentView={currentView}
                onViewChange={handleViewChange}
                versions={versions}
                version={version}
                onVersionChange={handleSidebarVersionChange}
            />

            <main className="content">
                {currentView === 'distribution' ? (
                    version ? (
                        <>
                            <header className="content-header">
                                <div>
                                    <p className="eyebrow">版本 {version}</p>
                                    <h2>分发矩阵</h2>
                                    <p className="helper-text">选择需要的渠道与架构，快速导出或扫码分发。</p>
                                </div>
                                <ThemeSwitcher theme={theme} onChange={setTheme} />
                            </header>

                            <FileList
                                version={version}
                                files={files}
                                fileMeta={fileMeta}
                                onQrOpen={setQrFile}
                            />
                        </>
                    ) : (
                        <div className="empty-placeholder">
                            <p>请选择左侧版本查看安装包。</p>
                        </div>
                    )
                ) : currentView === 'build' ? (
                    <BuildManager
                        theme={theme}
                        onThemeChange={setTheme}
                        versions={versions}
                        onOpenArtifacts={handleOpenArtifacts}
                        onArtifactsRefresh={refresh}
                    />
                ) : currentView === 'channelPublish' ? (
                    <ChannelPublish theme={theme} onThemeChange={setTheme} />
                ) : currentView === 'mappingFiles' ? (
                    <MappingFiles theme={theme} onThemeChange={setTheme} />
                ) : null}
            </main>

            <QrModal file={qrFile} version={version} onClose={() => setQrFile(null)} />
        </div>
    );
}
