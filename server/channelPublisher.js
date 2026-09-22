import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findApkForChannel, getChannelParams, getApplicationId, readChannelConfig } from './channelConfig.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.BUILD_DATA_ROOT || path.resolve(MODULE_DIR, './data');
// 任务元数据落盘：服务重启后仍能查看历史任务（渠道结果与时间线）
const TASK_HISTORY_PATH = path.join(DATA_ROOT, 'channel-tasks.json');
import { uploadHuawei } from './channels/huawei.js';
import { uploadOppo } from './channels/oppo.js';
import { uploadHonor } from './channels/honor.js';
import { uploadVivo } from './channels/vivo.js';
import { uploadMi } from './channels/mi.js';
import { uploadTencent } from './channels/tencent.js';

const MAX_CONCURRENT = 4;

// 渠道名 → 上传函数映射
const CHANNEL_UPLOADERS = {
  '华为': uploadHuawei,
  'OPPO': uploadOppo,
  '荣耀': uploadHonor,
  'VIVO': uploadVivo,
  '小米': uploadMi,
  '腾讯应用宝': uploadTencent,
};

// 任务状态
const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
};

// 渠道状态
const ChannelStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
};

class ChannelPublisher extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map(); // taskId → task
    this.activeCount = 0;
    this.queue = []; // {channelName, run} 等待并发槽
    this.loadPersistedTasks();
  }

  /** 启动时恢复历史任务；运行中任务标记为中断 */
  loadPersistedTasks() {
    try {
      if (!fs.existsSync(TASK_HISTORY_PATH)) return;
      const stored = JSON.parse(fs.readFileSync(TASK_HISTORY_PATH, 'utf8'));
      const loadedAt = Date.now();
      for (const entry of stored) {
        const task = { ...entry, channelResults: { ...entry.channelResults } };
        if (task.status === TaskStatus.RUNNING) {
          task.status = TaskStatus.FAILED;
          task.endTime = task.endTime || loadedAt;
          for (const name of Object.keys(task.channelResults)) {
            const result = task.channelResults[name];
            if (result.status === ChannelStatus.RUNNING || result.status === ChannelStatus.PENDING) {
              result.status = ChannelStatus.FAILED;
              result.message = result.message || '服务重启，任务中断';
            }
          }
        }
        this.tasks.set(task.taskId, task);
      }
    } catch (err) {
      console.warn(`[channel-publish] 加载历史任务失败: ${err.message}`);
    }
  }

  /** 任务元数据落盘（同步写，量小） */
  persistTasks() {
    try {
      fs.mkdirSync(path.dirname(TASK_HISTORY_PATH), { recursive: true });
      const tasks = Array.from(this.tasks.values())
        .sort((a, b) => (b.endTime || b.startTime || 0) - (a.endTime || a.startTime || 0));
      fs.writeFileSync(TASK_HISTORY_PATH, JSON.stringify(tasks, null, 2));
    } catch (err) {
      console.warn(`[channel-publish] 持久化任务失败: ${err.message}`);
    }
  }

  /**
   * 创建并启动一个发布任务
   * @param {string} version
   * @param {string[]} channelNames
   * @param {string} updateDesc
   * @param {string} [appId]
   * @param {string} [apkPath] 可选：直接指定 APK 路径（本地上传模式），所有渠道共用该文件，跳过 apks 目录匹配
   * @returns {object} task
   */
  async createTask(version, channelNames, updateDesc, appId, apkPath) {
    const taskId = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const packageName = getApplicationId(appId);

    // 初始化 channelResults
    const channelResults = {};
    for (const name of channelNames) {
      // 本地上传模式：所有渠道共用同一个 APK 文件
      let apkPathForChannel = apkPath;
      if (!apkPathForChannel) {
        const config = readChannelConfig(appId);
        const ch = (config.channels || []).find((c) => c.name === name);
        const fileNameIdentify = (ch?.params || []).find((p) => p.name === 'fileNameIdentify')?.value || name.toLowerCase();
        apkPathForChannel = findApkForChannel(version, fileNameIdentify);
      }
      channelResults[name] = {
        status: ChannelStatus.PENDING,
        progress: 0,
        message: '',
        apkPath: apkPathForChannel,
        apkName: apkPathForChannel ? apkPathForChannel.split('/').pop() : null,
      };
    }

    const task = {
      taskId,
      version,
      packageName,
      updateDesc,
      channelNames,
      channelResults,
      status: TaskStatus.RUNNING,
      startTime: Date.now(),
      endTime: null,
      appId,
    };

    this.tasks.set(taskId, task);
    this.persistTasks();

    // 异步启动所有渠道上传
    setImmediate(() => this._runTask(task));

    return task;
  }

  async _runTask(task) {
    const { taskId, channelNames, packageName, updateDesc, version, appId } = task;
    const promises = channelNames.map((channelName) =>
      this._acquireSlot().then(() => this._uploadChannel(task, channelName, packageName, updateDesc, appId))
    );
    await Promise.allSettled(promises);

    // 所有渠道完成后，汇总任务状态
    const allSuccess = channelNames.every(
      (n) => task.channelResults[n].status === ChannelStatus.SUCCESS
    );
    task.status = allSuccess ? TaskStatus.SUCCESS : TaskStatus.FAILED;
    task.endTime = Date.now();

    this._pruneTasks();
    this.persistTasks();
    this.emit('task_done', { taskId, status: task.status });
  }

  async _uploadChannel(task, channelName, packageName, updateDesc, appId) {
    const { taskId } = task;
    const result = task.channelResults[channelName];

    try {
      // 检查是否有对应 APK
      if (!result.apkPath) {
        result.status = ChannelStatus.FAILED;
        result.message = '未找到对应的 APK 文件';
        this._emitChannelUpdate(taskId, channelName, result);
        return;
      }

      // 检查是否有上传函数
      const uploader = CHANNEL_UPLOADERS[channelName];
      if (!uploader) {
        result.status = ChannelStatus.FAILED;
        result.message = `暂不支持渠道: ${channelName}`;
        this._emitChannelUpdate(taskId, channelName, result);
        return;
      }

      result.status = ChannelStatus.RUNNING;
      result.progress = 0;
      this._emitChannelUpdate(taskId, channelName, result);

      const params = getChannelParams(channelName, appId);
      await uploader(
        params,
        result.apkPath,
        packageName,
        updateDesc,
        (progress, message) => {
          result.progress = progress;
          if (message) result.message = message;
          this._emitChannelUpdate(taskId, channelName, result);
        }
      );
      result.status = ChannelStatus.SUCCESS;
      result.progress = 100;
      result.message = '上传成功';
    } catch (err) {
      result.status = ChannelStatus.FAILED;
      result.message = err.message || '上传失败';
    } finally {
      // 无论成功/失败/监听器抛错，都必须归还并发槽位，否则后续任务永久阻塞
      this._releaseSlot();
    }

    this._emitChannelUpdate(taskId, channelName, result);
  }

  _emitChannelUpdate(taskId, channelName, result) {
    this.emit('channel_update', {
      taskId,
      channelName,
      status: result.status,
      progress: result.progress,
      message: result.message,
    });
  }

  // 并发控制：获取槽位（最多 MAX_CONCURRENT 个并发）
  _acquireSlot() {
    if (this.activeCount < MAX_CONCURRENT) {
      this.activeCount++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  _releaseSlot() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next(); // 直接复用当前槽，不增减 activeCount
    } else {
      this.activeCount--;
    }
  }

  /**
   * 获取任务（含完整数据）
   */
  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  /**
   * 清理历史任务：保留最近 100 条或 24h 内的已完成/失败任务，防止内存无限增长
   */
  _pruneTasks() {
    const now = Date.now();
    const MAX_HISTORY = 100;
    const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
    const finished = Array.from(this.tasks.values())
      .filter((t) => t.status !== TaskStatus.RUNNING)
      .sort((a, b) => (b.endTime || 0) - (a.endTime || 0));
    for (const t of finished.slice(MAX_HISTORY)) {
      if (now - (t.endTime || now) > HISTORY_TTL_MS) {
        this.tasks.delete(t.taskId);
      }
    }
  }

  /**
   * 获取所有任务列表（轻量摘要）
   */
  getAllTasks() {
    return Array.from(this.tasks.values()).map(serializeTask);
  }

  /**
   * 获取活跃任务
   */
  getActiveTasks() {
    return Array.from(this.tasks.values())
      .filter((t) => t.status === TaskStatus.RUNNING)
      .map(serializeTask);
  }

  /**
   * 获取历史任务（已完成/失败）
   */
  getHistoryTasks() {
    return Array.from(this.tasks.values())
      .filter((t) => t.status !== TaskStatus.RUNNING)
      .sort((a, b) => b.endTime - a.endTime)
      .map(serializeTask);
  }
}

function serializeTask(task) {
  return {
    taskId: task.taskId,
    version: task.version,
    packageName: task.packageName,
    updateDesc: task.updateDesc,
    channelNames: task.channelNames,
    channelResults: task.channelResults,
    status: task.status,
    startTime: task.startTime,
    endTime: task.endTime,
    appId: task.appId,
  };
}

// 单例
export const channelPublisher = new ChannelPublisher();
export { TaskStatus, ChannelStatus, serializeTask };
