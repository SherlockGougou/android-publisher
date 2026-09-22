import { CHANNEL_NAMES } from './constants';

export function getBitType(filename) {
    if (/arm64|x64|64/.test(filename)) return '64';
    if (/armeabi|x86|32/.test(filename)) return '32';
    return '未知';
}

export function getChannel(filename) {
    const match = filename.match(/(huawei|vivo|honor|xiaomi|oppo|tencent|official)/i);
    if (!match) return '其他';
    return CHANNEL_NAMES[match[1].toLowerCase()] || '其他';
}

export function formatTime(value) {
    if (!value) return '加载中…';
    if (value === '未知') return '未知';

    try {
        const date = new Date(value);
        const timestamp = date.getTime();
        if (Number.isNaN(timestamp)) return value;

        const now = new Date();
        const nowTimestamp = now.getTime();
        const isSameYear = now.getFullYear() === date.getFullYear();
        const isSameDay = isSameYear
            && now.getMonth() === date.getMonth()
            && now.getDate() === date.getDate();

        if (isSameDay && timestamp <= nowTimestamp) {
            const diffMs = nowTimestamp - timestamp;
            const diffMinutes = Math.floor(diffMs / 60000);

            if (diffMinutes < 1) {
                return '刚刚';
            }

            if (diffMinutes < 60) {
                return `${diffMinutes} 分钟前`;
            }

            return `${Math.floor(diffMinutes / 60)} 小时前`;
        }

        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');

        return isSameYear
            ? `${month}-${day} ${hours}:${minutes}:${seconds}`
            : `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    } catch (err) {
        console.error('格式化时间失败', err);
        return '未知';
    }
}

export function formatRelativeTime(value) {
    if (!value) return '加载中…';
    if (value === '未知') return '未知';

    const date = new Date(value);
    const timestamp = date.getTime();

    if (Number.isNaN(timestamp)) {
        return typeof value === 'string' ? value : '未知';
    }

    const diff = timestamp - Date.now();
    const absMinutes = Math.round(Math.abs(diff) / 60000);

    if (absMinutes < 1) {
        return diff <= 0 ? '刚刚' : '即将';
    }

    if (absMinutes < 60) {
        return diff <= 0 ? `${absMinutes} 分钟前` : `${absMinutes} 分钟后`;
    }

    const absHours = Math.round(absMinutes / 60);
    if (absHours < 24) {
        return diff <= 0 ? `${absHours} 小时前` : `${absHours} 小时后`;
    }

    const absDays = Math.round(absHours / 24);
    if (absDays < 7) {
        return diff <= 0 ? `${absDays} 天前` : `${absDays} 天后`;
    }

    return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function formatTaskTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
}

export function formatDuration(startedAt, endedAt) {
    if (!startedAt) return '-';
    const start = new Date(startedAt).getTime();
    const end = endedAt ? new Date(endedAt).getTime() : Date.now();
    if (Number.isNaN(start) || Number.isNaN(end)) return '-';

    const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes === 0) {
        return `${seconds} 秒`;
    }

    return `${minutes} 分 ${seconds} 秒`;
}
