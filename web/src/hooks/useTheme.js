import { useEffect, useState } from 'react';

/**
 * 管理浅色/深色/跟随系统主题，并同步 body class。
 * @returns {{ theme: string, setTheme: Function }}
 */
export function useTheme() {
    const [theme, setTheme] = useState('system');

    useEffect(() => {
        document.body.classList.add('app-body');
        const matchDark = window.matchMedia('(prefers-color-scheme: dark)');

        const applyTheme = () => {
            const isDark = theme === 'system' ? matchDark.matches : theme === 'dark';
            document.body.classList.toggle('dark', isDark);
            document.body.classList.toggle('light', !isDark);
        };

        applyTheme();

        const handler = () => {
            if (theme === 'system') applyTheme();
        };
        matchDark.addEventListener('change', handler);

        return () => {
            document.body.classList.remove('app-body', 'dark', 'light');
            matchDark.removeEventListener('change', handler);
        };
    }, [theme]);

    return { theme, setTheme };
}
