import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { getBuildConfig, listApps } from './channelConfig.js';

const HISTORY_LIMIT = 30;
const DEFAULT_BUILD_BRANCH = process.env.BUILD_DEFAULT_BRANCH || 'main';
const FINAL_STATUSES = new Set(['success', 'failed', 'cancelled']);
const STATUS_META = {
  starting: { label: '任务初始化', progress: 5 },
  preparing: { label: '准备代码仓库', progress: 16 },
  building: { label: '执行构建脚本', progress: 42 },
  success: { label: '打包完成', progress: 100 },
  failed: { label: '打包失败', progress: 0 },
  cancelled: { label: '任务已终止', progress: 0 },
};

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isFinalStatus(status) {
  return FINAL_STATUSES.has(status);
}

function trimText(value) {
  return String(value || '').trim();
}

function now() {
  return new Date().toISOString();
}

function serializeTask(task) {
  if (!task) return null;
  const { currentChildPid, currentChildCommand, currentStageText, cancelRequestedAt, ...rest } = task;
  return {
    ...rest,
    isActive: !isFinalStatus(task.status),
    cancelRequestedAt: cancelRequestedAt || null,
    currentChildPid: currentChildPid || null,
    currentChildCommand: currentChildCommand || null,
    currentStageText: currentStageText || STATUS_META[task.status]?.label || '',
  };
}

function normalizeBranch(branch) {
  return trimText(branch).replace(/^origin\//, '');
}

function parseBranchRefs(output) {
  return output
    .split(/\r?\n/)
    .map((line) => {
      const [refName, updatedAt = ''] = line.split('\0');
      return {
        branch: normalizeBranch(refName),
        updatedAt: trimText(updatedAt),
      };
    })
    .filter(({ branch }) => branch && branch !== 'HEAD' && branch !== 'origin');
}

function buildCommandLine(command, args) {
  return [command, ...args].join(' ');
}

function stripCommitPrefix(message) {
  return trimText(message).replace(/^(feat|fix|refactor|perf|docs|style|test|build|ci|chore)(\([^)]+\))?:\s*/i, '');
}

function isIgnorableUpdateLogMessage(message, branch) {
  const normalizedMessage = trimText(message).toLowerCase();
  const normalizedBranch = normalizeBranch(branch).toLowerCase();

  if (!normalizedMessage) {
    return true;
  }

  if (normalizedBranch && normalizedMessage === normalizedBranch) {
    return true;
  }

  return /^(?:v?\d+(?:\.\d+){1,3}|(?:dev|main|master|release|hotfix)[/_-]v?\d+(?:\.\d+){1,3})$/i.test(normalizedMessage);
}

function isMergeCommit(parentHashes) {
  return trimText(parentHashes).split(/\s+/).filter(Boolean).length > 1;
}

function readJsonSafe(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) return fallbackValue;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

class CancelledError extends Error {
  constructor(message = '任务已终止') {
    super(message);
    this.name = 'CancelledError';
  }
}

class StepFailedError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'StepFailedError';
    this.exitCode = exitCode;
  }
}

export class BuildManager {
  constructor({ apkRoot, dataRoot, port }) {
    this.apkRoot = path.resolve(apkRoot);
    this.dataRoot = path.resolve(dataRoot);
    this.port = port;
    this.logDir = path.join(this.dataRoot, 'logs');
    this.historyPath = path.join(this.dataRoot, 'build-history.json');
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.tasks = new Map();
    this.activeTaskId = null;

    ensureDirSync(this.dataRoot);
    ensureDirSync(this.logDir);
    this.loadHistory();
  }

  loadHistory() {
    const stored = readJsonSafe(this.historyPath, []);
    const loadedAt = now();
    stored.forEach((entry) => {
      const task = { ...entry };
      if (!isFinalStatus(task.status)) {
        task.status = 'failed';
        task.error = '服务重启，任务状态已中断';
        task.endedAt = loadedAt;
        task.currentStageText = STATUS_META.failed.label;
      }
      this.tasks.set(task.id, task);
    });
    this.persistHistory();
  }

  persistHistory() {
    const sortedEntries = Array.from(this.tasks.entries())
      .sort(([, left], [, right]) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    const retainedEntries = sortedEntries.slice(0, HISTORY_LIMIT);
    const retainedIds = new Set(retainedEntries.map(([taskId]) => taskId));

    Array.from(this.tasks.keys()).forEach((taskId) => {
      if (!retainedIds.has(taskId) && taskId !== this.activeTaskId) {
        this.tasks.delete(taskId);
      }
    });

    const serializedTasks = retainedEntries
      .map(([, task]) => task)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .map((task) => serializeTask(task));

    fs.writeFileSync(this.historyPath, JSON.stringify(serializedTasks, null, 2));
  }

  getHistory() {
    return Array.from(this.tasks.values())
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .map((task) => serializeTask(task));
  }

  getActiveTask() {
    if (!this.activeTaskId) return null;
    return this.tasks.get(this.activeTaskId) || null;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  /**
   * 列出应用的可用分支；非 Git 项目返回 isGitRepo=false（前端会隐藏分支选择）
   */
  async listBranches({ appId, refreshRemote = false } = {}) {
    const resolvedAppId = appId || this.defaultAppId();
    const build = resolvedAppId ? getBuildConfig(resolvedAppId) : { projectRoot: '', script: '' };
    const projectRoot = build.projectRoot;
    const isGitRepo = Boolean(projectRoot) && fs.existsSync(path.join(projectRoot, '.git'));

    if (!isGitRepo) {
      return {
        appId: resolvedAppId,
        isGitRepo: false,
        branches: [],
        branchMeta: {},
        currentBranch: '',
        defaultBranch: '',
        suggestedVersion: '',
        suggestedUpdateLog: '',
      };
    }

    const gitOptions = { cwd: projectRoot };

    if (refreshRemote) {
      await this.captureCommand('git', ['fetch', '--all', '--prune'], gitOptions);
    }

    const remoteEntries = parseBranchRefs(await this.captureCommand('git', [
      'for-each-ref',
      '--format=%(refname:short)%00%(committerdate:iso8601-strict)',
      'refs/remotes/origin',
    ], gitOptions));
    const localEntries = parseBranchRefs(await this.captureCommand('git', [
      'for-each-ref',
      '--format=%(refname:short)%00%(committerdate:iso8601-strict)',
      'refs/heads',
    ], gitOptions));
    const currentBranch = normalizeBranch(await this.captureCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], gitOptions));
    const remoteBranches = Array.from(
      new Set(remoteEntries.map(({ branch }) => branch)),
    );
    const localBranches = Array.from(
      new Set(localEntries.map(({ branch }) => branch)),
    );
    const branches = (remoteBranches.length ? remoteBranches : localBranches)
      .sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    const remoteBranchMeta = new Map(remoteEntries.map(({ branch, updatedAt }) => [branch, { updatedAt }]));
    const localBranchMeta = new Map(localEntries.map(({ branch, updatedAt }) => [branch, { updatedAt }]));

    const defaultBranch = branches.includes(DEFAULT_BUILD_BRANCH)
      ? DEFAULT_BUILD_BRANCH
      : currentBranch || branches[0] || '';
    const [suggestedVersion, suggestedUpdateLog] = defaultBranch
      ? await Promise.all([
          this.readVersionNameFromBranch(defaultBranch, projectRoot),
          this.buildUpdateLogSummary(defaultBranch, projectRoot),
        ])
      : ['', ''];

    return {
      appId: resolvedAppId,
      isGitRepo: true,
      branches,
      branchMeta: Object.fromEntries(
        branches.map((branch) => [
          branch,
          remoteBranchMeta.get(branch) || localBranchMeta.get(branch) || { updatedAt: '' },
        ]),
      ),
      currentBranch,
      defaultBranch,
      suggestedVersion,
      suggestedUpdateLog,
    };
  }

  async getHealth(appId) {
    const resolvedAppId = appId || this.defaultAppId();
    if (!resolvedAppId) {
      return {
        appId: '',
        error: '尚未配置任何应用（请在配置目录中创建 <applicationId>.json）',
        apkRoot: this.apkRoot,
        activeTaskId: this.activeTaskId,
        checks: { apkRootExists: await this.pathExists(this.apkRoot) },
        commands: {},
      };
    }

    const build = getBuildConfig(resolvedAppId);
    const projectRoot = build.projectRoot;
    const projectExists = projectRoot ? await this.pathExists(projectRoot) : false;
    const gitRepoExists = projectRoot ? await this.pathExists(path.join(projectRoot, '.git')) : false;
    const [gitPath, bashPath, javaPath] = await Promise.all([
      this.findCommand(['git']),
      this.findCommand(['bash']),
      this.findCommand(['java']),
    ]);

    return {
      appId: resolvedAppId,
      projectRoot,
      buildScript: build.script,
      apkRoot: this.apkRoot,
      activeTaskId: this.activeTaskId,
      checks: {
        projectRootExists: projectExists,
        buildScriptExists: build.script ? await this.pathExists(build.script) : false,
        isGitRepo: gitRepoExists,
        apkRootExists: await this.pathExists(this.apkRoot),
        gitAvailable: Boolean(gitPath),
        bashAvailable: Boolean(bashPath),
        javaAvailable: Boolean(javaPath),
      },
      commands: {
        git: gitPath,
        bash: bashPath,
        java: javaPath,
      },
    };
  }

  defaultAppId() {
    const apps = listApps();
    return apps[0]?.applicationId || '';
  }

  async startTask({ appId, branch, version, updateLog }) {
    if (this.getActiveTask()) {
      throw new Error('已有任务正在运行，请先终止或等待当前任务完成');
    }

    const resolvedAppId = appId || this.defaultAppId();
    if (!resolvedAppId) {
      throw new Error('缺少 appId：请先在配置目录中创建应用配置');
    }

    const build = getBuildConfig(resolvedAppId);
    if (!build.projectRoot || !fs.existsSync(build.projectRoot)) {
      throw new Error(`应用「${resolvedAppId}」未配置有效的构建项目目录（build.projectRoot），无法执行构建`);
    }
    if (!build.script || !fs.existsSync(build.script)) {
      throw new Error(`应用「${resolvedAppId}」未配置有效的构建脚本（build.script），无法执行构建`);
    }
    const isGitRepo = fs.existsSync(path.join(build.projectRoot, '.git'));

    const normalizedBranch = normalizeBranch(branch);
    const normalizedVersion = trimText(version);
    const normalizedUpdateLog = trimText(updateLog) || '无';

    if (isGitRepo && !normalizedBranch) {
      throw new Error('分支不能为空');
    }
    if (!normalizedVersion) {
      throw new Error('版本号不能为空');
    }
    if (/[\\/]/.test(normalizedVersion)) {
      throw new Error('版本号不能包含路径分隔符');
    }

    const taskId = randomUUID();
    const logFile = path.join(this.logDir, `${taskId}.log`);
    const task = {
      id: taskId,
      appId: resolvedAppId,
      projectRoot: build.projectRoot,
      buildScript: build.script,
      isGitRepo,
      branch: normalizedBranch || '',
      version: normalizedVersion,
      updateLog: normalizedUpdateLog,
      status: 'starting',
      progress: STATUS_META.starting.progress,
      createdAt: now(),
      startedAt: null,
      endedAt: null,
      error: null,
      artifactVersion: null,
      commitHash: '',
      commitMessage: '',
      exitCode: null,
      currentStageText: STATUS_META.starting.label,
      currentChildPid: null,
      currentChildCommand: null,
      cancelRequestedAt: null,
      logFile,
      lineCount: 0,
    };

    this.tasks.set(task.id, task);
    this.activeTaskId = task.id;
    fs.writeFileSync(logFile, '', 'utf8');
    this.persistHistory();
    this.emitTask(task);

    this.runTask(task).catch((error) => {
      if (!isFinalStatus(task.status)) {
        this.failTask(task, error instanceof Error ? error.message : String(error), error?.exitCode || 1);
      }
    });

    return serializeTask(task);
  }

  async cancelTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error('任务不存在');
    }
    if (isFinalStatus(task.status)) {
      return serializeTask(task);
    }

    task.cancelRequestedAt = now();
    this.appendLog(task, '收到终止请求，正在停止当前任务', 'system');
    this.emitTask(task);

    if (task.currentChildPid) {
      this.terminateProcessGroup(task.currentChildPid, 'SIGTERM');
      setTimeout(() => {
        if (!isFinalStatus(task.status) && task.currentChildPid) {
          this.appendLog(task, '子进程未及时退出，升级为 SIGKILL', 'system');
          this.terminateProcessGroup(task.currentChildPid, 'SIGKILL');
        }
      }, 5000).unref();
    }

    return serializeTask(task);
  }

  async getTaskLogs(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    if (!(await this.pathExists(task.logFile))) return '';
    return fsp.readFile(task.logFile, 'utf8');
  }

  subscribe(taskId, listener) {
    const eventName = this.getEventName(taskId);
    this.events.on(eventName, listener);
    return () => this.events.off(eventName, listener);
  }

  async runTask(task) {
    task.startedAt = now();
    this.setTaskStatus(task, 'preparing', task.isGitRepo ? '同步分支与清理工作区' : '准备构建环境');

    if (task.isGitRepo) {
      const cwd = task.projectRoot;
      await this.runCommand(task, 'git', ['fetch', '--all', '--prune'], { stageText: '同步远程分支', progress: 10, cwd });
      await this.runCommand(task, 'git', ['checkout', '-f', task.branch], {
        stageText: '切换目标分支',
        progress: 16,
        cwd,
      });

      const resetTarget = (await this.hasRemoteBranch(task.branch, cwd)) ? `origin/${task.branch}` : task.branch;
      await this.runCommand(task, 'git', ['reset', '--hard', resetTarget], {
        stageText: `重置到 ${resetTarget}`,
        progress: 22,
        cwd,
      });
      await this.runCommand(task, 'git', [
        'clean',
        '-fd',
        '-e',
        'local.properties',
        '-e',
        '*/local.properties',
        '-e',
        '*.jks',
        '-e',
        '*.keystore',
        '-e',
        '*.keystore.txt',
      ], {
        stageText: '清理未跟踪文件',
        progress: 26,
        cwd,
      });

      task.commitHash = await this.captureCommand('git', ['rev-parse', '--short', 'HEAD'], { cwd });
      task.commitMessage = await this.captureCommand('git', ['log', '-1', '--pretty=%s'], { cwd });
    } else {
      this.appendLog(task, '未检测到 Git 仓库，跳过分支同步步骤（直接执行构建脚本）', 'system');
    }
    this.persistAndEmit(task);

    this.setTaskStatus(task, 'building', '执行构建脚本');
    // 构建入口为用户自备的构建脚本：bash <script> <version> <updateLog>
    // 脚本需将 APK 产物写入 OUTPUT_DIR（构建脚本契约详见 README）
    await this.runCommand(task, 'bash', [task.buildScript, task.version, task.updateLog], {
      stageText: '执行构建脚本',
      progress: 42,
      cwd: task.projectRoot,
      extraEnv: {
        OUTPUT_DIR: path.join(this.apkRoot, task.version),
        PROJECT_ROOT: task.projectRoot,
        APP_VERSION: task.version,
        APP_CHANGELOG: task.updateLog,
      },
    });

    this.completeTask(task);
  }

  async runCommand(task, command, args, options = {}) {
    this.assertNotCancelled(task);
    const {
      stageText = STATUS_META[task.status]?.label || '',
      progress = task.progress,
      cwd = process.cwd(),
      extraEnv = {},
    } = options;

    task.progress = progress;
    task.currentStageText = stageText;
    task.currentChildCommand = buildCommandLine(command, args);
    this.persistAndEmit(task);
    this.appendLog(task, `$ ${task.currentChildCommand}`, 'command');

    await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...this.getCommandEnv(cwd), ...extraEnv },
        detached: true,
      });
      task.currentChildPid = child.pid || null;
      this.persistAndEmit(task);

      const attach = (streamName, source) => {
        let buffer = '';
        source.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          lines.forEach((line) => this.handleOutputLine(task, line, streamName));
        });
        source.on('end', () => {
          if (buffer) {
            this.handleOutputLine(task, buffer, streamName);
          }
        });
      };

      attach('stdout', child.stdout);
      attach('stderr', child.stderr);

      child.on('error', (error) => {
        task.currentChildPid = null;
        task.currentChildCommand = null;
        reject(error);
      });

      child.on('close', (code, signal) => {
        task.currentChildPid = null;
        task.currentChildCommand = null;
        this.persistAndEmit(task);

        if (task.cancelRequestedAt) {
          reject(new CancelledError());
          return;
        }

        if (signal) {
          reject(new StepFailedError(`命令因信号 ${signal} 退出: ${buildCommandLine(command, args)}`));
          return;
        }

        if (code !== 0) {
          reject(new StepFailedError(`命令执行失败(${code}): ${buildCommandLine(command, args)}`, code || 1));
          return;
        }

        resolve();
      });
    });
  }

  handleOutputLine(task, line, streamName) {
    const text = trimText(line);
    if (!text) return;

    // 构建阶段维持「准备 → 构建中 → 成功/失败」三态，由任务状态机驱动，
    // 不再解析具体脚本的输出标记；脚本如需暴露更多阶段，可自行约定标记并在此扩展。
    this.appendLog(task, text, streamName);
  }

  async hasRemoteBranch(branch, cwd) {
    try {
      await this.captureCommand('git', ['rev-parse', '--verify', `origin/${branch}`], { cwd });
      return true;
    } catch {
      return false;
    }
  }

  async resolveBranchRef(branch, cwd) {
    const normalizedBranch = normalizeBranch(branch);
    if (!normalizedBranch) return '';

    if (await this.hasRemoteBranch(normalizedBranch, cwd)) {
      return `origin/${normalizedBranch}`;
    }

    try {
      await this.captureCommand('git', ['rev-parse', '--verify', normalizedBranch], { cwd });
      return normalizedBranch;
    } catch {
      return '';
    }
  }

  async readVersionNameFromBranch(branch, projectRoot) {
    const ref = await this.resolveBranchRef(branch, projectRoot);
    if (!ref) return '';

    try {
      // 尽力而为：兼容标准 Android 项目布局（app/build.gradle）；读取失败不影响主流程
      const gradleContent = await this.captureCommand('git', ['show', `${ref}:app/build.gradle`], { cwd: projectRoot });
      const match = gradleContent.match(/versionName\s+['"]([^'"]+)['"]/);
      return match?.[1] || '';
    } catch {
      return '';
    }
  }

  async buildUpdateLogSummary(branch, projectRoot) {
    const ref = await this.resolveBranchRef(branch, projectRoot);
    if (!ref) return '';

    try {
      const parentHashes = await this.captureCommand('git', ['log', '-1', '--pretty=%P', ref], { cwd: projectRoot });
      if (isMergeCommit(parentHashes)) {
        return '';
      }

      const subject = trimText(stripCommitPrefix(await this.captureCommand('git', ['log', '-1', '--pretty=%s', ref], { cwd: projectRoot })));
      if (!subject || isIgnorableUpdateLogMessage(subject, branch)) {
        return '';
      }

      return subject;
    } catch {
      return '';
    }
  }

  async captureCommand(command, args, options = {}) {
    const { cwd = process.cwd() } = options;
    const output = [];

    await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: this.getCommandEnv(cwd),
      });
      child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
      child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new StepFailedError(`命令执行失败(${code}): ${buildCommandLine(command, args)}`, code || 1));
          return;
        }
        resolve();
      });
    });

    return output.join('').trim();
  }

  async pathExists(targetPath) {
    try {
      await fsp.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async findCommand(candidates) {
    for (const candidate of candidates) {
      try {
        const output = await this.captureShellCommand(`command -v ${candidate}`);
        if (output) return output;
      } catch {
        continue;
      }
    }
    return '';
  }

  async captureShellCommand(script) {
    return this.captureCommand('bash', ['-lc', script]);
  }

  appendLog(task, line, streamName) {
    const prefix = streamName === 'stderr' ? '[stderr] ' : streamName === 'command' ? '[command] ' : streamName === 'system' ? '[system] ' : '';
    const entry = `${new Date().toLocaleString('zh-CN', { hour12: false })} ${prefix}${line}`;
    fs.appendFileSync(task.logFile, `${entry}\n`, 'utf8');
    task.lineCount += 1;
    this.events.emit(this.getEventName(task.id), {
      type: 'log',
      payload: {
        line: entry,
        stream: streamName,
      },
    });
  }

  setTaskStatus(task, status, stageText) {
    task.status = status;
    task.progress = STATUS_META[status]?.progress ?? task.progress;
    task.currentStageText = stageText || STATUS_META[status]?.label || task.currentStageText;
    this.persistAndEmit(task);
  }

  completeTask(task) {
    task.status = 'success';
    task.progress = STATUS_META.success.progress;
    task.currentStageText = STATUS_META.success.label;
    task.artifactVersion = task.version;
    task.exitCode = 0;
    task.endedAt = now();
    this.activeTaskId = null;
    this.persistAndEmit(task);
    this.events.emit(this.getEventName(task.id), { type: 'end', payload: { taskId: task.id } });
  }

  failTask(task, message, exitCode = 1) {
    task.status = task.cancelRequestedAt ? 'cancelled' : 'failed';
    task.error = message;
    task.exitCode = exitCode;
    task.endedAt = now();
    task.currentStageText = task.cancelRequestedAt ? STATUS_META.cancelled.label : STATUS_META.failed.label;
    if (task.cancelRequestedAt) {
      this.appendLog(task, '任务已终止', 'system');
    }
    this.activeTaskId = null;
    this.persistAndEmit(task);
    this.events.emit(this.getEventName(task.id), { type: 'end', payload: { taskId: task.id } });
  }

  persistAndEmit(task) {
    this.persistHistory();
    this.emitTask(task);
  }

  emitTask(task) {
    this.events.emit(this.getEventName(task.id), {
      type: 'task',
      payload: serializeTask(task),
    });
  }

  assertNotCancelled(task) {
    if (task.cancelRequestedAt) {
      throw new CancelledError();
    }
  }

  terminateProcessGroup(pid, signal) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        return;
      }
    }
  }

  getCommandEnv(cwd) {
    return {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: cwd || process.cwd(),
    };
  }

  getEventName(taskId) {
    return `task:${taskId}`;
  }
}

export { serializeTask, isFinalStatus };
