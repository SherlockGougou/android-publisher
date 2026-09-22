export const API = '/api/apks';
export const DOWNLOAD = '/download';
export const BUILD_API = '/api/builds';

export const BIT_FILTERS = [
    { label: '全部', value: '全部' },
    { label: '32-bit', value: '32' },
    { label: '64-bit', value: '64' },
];

export const CHANNEL_NAMES = {
    huawei: '华为',
    vivo: 'vivo',
    honor: '荣耀',
    xiaomi: '小米',
    oppo: 'Oppo',
    tencent: '应用宝',
    official: '官方',
};

export const VALID_CHANNELS = Object.values(CHANNEL_NAMES);

export const BUILD_STATUS_LABELS = {
    starting: '初始化',
    preparing: '准备中',
    building: '打包中',
    packaging: '整理产物',
    uploading: '上传中',
    success: '成功',
    failed: '失败',
    cancelled: '已终止',
};

export const BUILD_STATUS_TONES = {
    starting: 'muted',
    preparing: 'info',
    building: 'info',
    packaging: 'warning',
    uploading: 'warning',
    success: 'success',
    failed: 'danger',
    cancelled: 'muted',
};
