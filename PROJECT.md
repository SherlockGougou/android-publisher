# Android Publisher · 开发指南

自部署的 Android 应用打包与国内商店发布平台。面向开发与维护者的架构说明。

## 架构

```
web (React/Vite) → REST API (server/index.js) → 任务管理器 → 构建脚本 / 渠道上传器 → data/ 归档
```

- `server/` — Node 20 + Express（全部 ESM）
  - `index.js` — 入口与全部路由：分发（apks/mappings/download）、构建（builds）、渠道（channel-publish）、二维码、通知；静态托管 `web/dist`
  - `buildManager.js` — 单飞构建任务（同一时间一个）。状态机：`starting → preparing → building → success|failed|cancelled`；日志落盘 `data/logs/<taskId>.log`；历史持久化 `data/build-history.json`（重启恢复）
  - `channelPublisher.js` — 渠道上传任务，最多 4 路并发；任务元数据持久化 `data/channel-tasks.json`（重启恢复）
  - `channelConfig.js` — 应用配置加载、脱敏（`getSafeChannelConfig`）、APK 按渠道匹配（`findApkForChannel`）、构建配置解析（`getBuildConfig`）
  - `apkUtils.js` — 文件名解析版本号、aapt 包名校验（无 aapt 时降级跳过）
  - `channels/` — 六家商店 API 客户端：`huawei.js`/`mi.js`/`oppo.js`/`vivo.js`/`honor.js`/`tencent.js`，每个导出 `upload*` / `query*`
  - `channels/utils/` — token 缓存、重试、HTTP 脱敏日志、按天滚动文件日志
- `web/` — React 18 + Vite + Framer Motion；四个视图：分发中心 / 打包管理 / 渠道发布 / Mapping 文件
- `data/` — 运行数据（APK 归档、任务、日志），运行时生成，不入库
- `config/apps/` — 应用配置目录（`<applicationId>.json`），含商店密钥，不入库

## 目录与数据契约（勿随意更改）

- APK 归档布局：`data/apks/<version>/`（允许子目录），平台递归扫描 `.apk` 文件
- 构建脚本必须把产物写入平台注入的 `OUTPUT_DIR`（= `APK_ROOT/<version>`）
- 渠道 APK 匹配：文件名包含 `fileNameIdentify`（配置在渠道 `params` 中）
- 前端构建产物 `web/dist` 由服务端静态托管；SPA fallback 到 `index.html`

## 常用命令

```bash
npm --prefix server install     # 后端依赖
npm --prefix web install        # 前端依赖
npm run dev:server              # 后端 :3000
npm run dev:web                 # 前端 :5173（代理 /api、/download）
npm --prefix web run build      # 前端生产构建
bash docker_run.sh              # 构建镜像并启动容器
```

## 环境变量（完整）

运行时（全部可选，均有默认值）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务端口 |
| `BUILD_DATA_ROOT` | `server/data`（容器 `/app/data`） | 数据根目录（APK、任务、日志） |
| `APK_ROOT` | `<数据根>/apks` | APK 归档目录 |
| `CONFIG_DIR` | `config/apps`（容器 `/app/config/apps`） | 应用配置目录；也支持 `CHANNEL_CONFIG_PATH` 单文件模式 |
| `CHANNEL_UPLOAD_DIR` | `<数据根>/channel-uploads` | 本地上传 APK 的留档目录 |
| `CHANNEL_LOG_DIR` | `<数据根>/logs` | 渠道/构建日志目录 |
| `CHANNEL_LOG_RETENTION_DAYS` | `30` | 日志保留天数 |
| `CHANNEL_LOG_MAX_SIZE` | `52428800` | 单日志文件上限（字节），超限滚动 |
| `CHANNEL_HTTP_DEBUG` | `false` | 记录渠道 HTTP 明细（自动脱敏） |
| `WEBHOOK_URL` | 空 | 通知地址（兼容旧名 `FEISHU_WEBHOOK`） |
| `BUILD_DEFAULT_BRANCH` | `main` | 构建页默认分支 |
| `BUILD_PROJECT_ROOT` / `BUILD_RELEASE_RUNNER` | 空 | 单应用兜底构建配置（优先级低于应用配置 `build` 段） |

构建期（Docker build args）：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `BASE_IMAGE` | `node:20-bookworm-slim` | 基础镜像（国内可换 `docker.m.daocloud.io/library/node:20-bookworm-slim`） |
| `NPM_REGISTRY` | `https://registry.npmjs.org/` | npm 源（国内可换 `https://registry.npmmirror.com`） |

## 编码约定

- 全部 ESM（`"type": "module"`）；注释与用户可见文案用中文
- 错误经 Express `next(error)` 或统一 JSON `{ success:false, error }` 返回
- 新增渠道参数时需同步三处：`channelConfig.js` 的 `SENSITIVE_PARAM_NAMES`（如需脱敏）、README 参数表、`examples/app.demo.json`
- 修改构建契约时需同步：README「构建脚本契约」、`examples/build.sh`

## 边界（不应该出现的东西）

- 任何真实渠道密钥、Webhook 地址、内部域名、私有包名、本机绝对路径
- 私有业务模块（如圈子更新器、深链生成器）——如需类似能力，以通用形态独立设计
- v0.1 无鉴权：README 顶部安全声明与行为必须保持一致；引入鉴权属于功能变更，需同步文档

## 自检清单（提交前）

1. `find server -name '*.js' -not -path '*/node_modules/*' -exec node --check {} \;`
2. `npm --prefix web run build`
3. 本地起服务冒烟：`curl localhost:3000/api/apps`、`/api/apks`、`/api/builds/history`
4. 自查没有把密钥/私有信息写入任何可提交文件
