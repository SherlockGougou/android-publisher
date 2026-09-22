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
