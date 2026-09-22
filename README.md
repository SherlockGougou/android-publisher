# Android Publisher

自部署的 Android 应用打包与国内应用商店发布平台。

把 APK（在服务器上构建，或直接上传）一键发布到 **华为 / 小米 / OPPO / VIVO / 荣耀 / 腾讯应用宝**，
自动查询各商店审核状态，并通过 Webhook（飞书 / 钉钉 / 企业微信 / 通用 JSON）推送结果。

> 与 [小篆传包（XiaoZhuan）](https://github.com/Xigong93/XiaoZhuan)（桌面版一键上架）互补：
> 桌面工具适合个人快速传包；Android Publisher 是自部署 Web 平台，适合多应用、多人使用与自动化。

## 功能一览（v0.1）

- **分发中心**：按版本浏览 APK 产物、单个/批量下载、扫码分享（二维码）
- **打包管理**：选择应用与 Git 分支，触发服务器上的构建脚本；实时日志、任务历史、随时终止
- **渠道发布**：六家商店上传 / 提交审核 / 状态查询；最多 4 路并发、实时进度推送、渠道日志留档
- **通知**：一键把各渠道审核状态推送到飞书 / 钉钉 / 企业微信机器人（或任意 HTTP 端点）
- **多应用**：配置目录中每个 JSON 描述一个应用，互不干扰
- **任务持久化**：构建与渠道任务元数据落盘，服务重启后历史仍可查看

## 快速开始（Docker）

```bash
git clone <本仓库地址> android-publisher && cd android-publisher

# 1) 准备应用配置（每个应用一份，示例见 examples/app.demo.json）
mkdir -p config/apps data
cp examples/app.demo.json config/apps/com.example.demo.json
# 编辑 com.example.demo.json：applicationId、应用名称、各商店密钥等

# 2) 构建并启动
bash docker_run.sh
# 或者：docker compose up -d --build

# 3) 打开 http://localhost:3000
```

上传一次 APK 试试：**分发中心 → 选择版本 → 上传**（或配置好构建后再走「打包管理」）。

## 应用配置

配置目录：`config/apps/<applicationId>.json`（容器内为 `/app/config/apps/`）。
完整示例见 [`examples/app.demo.json`](examples/app.demo.json)。

| 字段 | 说明 |
| --- | --- |
| `applicationId` | 应用包名，必须与 APK 实际包名一致（本地上传时会用 aapt 校验） |
| `name` | 展示名称 |
| `enableChannel` | 是否启用渠道发布 |
| `build.projectRoot` | 构建项目根目录（容器内路径，如 `/app/project`；相对路径按配置目录解析） |
| `build.script` | 构建脚本路径（用户自备 sh，契约见下） |
| `extension.updateDesc` | 发布页默认更新日志 |
| `extension.webhookUrl` | 该应用的通知 Webhook（也可用环境变量 `WEBHOOK_URL` 统一配置） |
| `channels[]` | 渠道列表：`name` / `enable` / `params[]` |

各商店 `params` 参数名：

| 渠道 | 参数 |
| --- | --- |
| 华为 | `client_id`、`client_secret` |
| 小米 | `account`、`publicKey`、`privateKey` |
| OPPO | `client_id`、`client_secret` |
| VIVO | `access_key`、`access_secret` |
| 荣耀 | `client_id`、`client_secret` |
| 腾讯应用宝 | `user_id`、`access_secret`、`app_id` |

每个渠道还有一个 `fileNameIdentify` 参数：平台在产物目录中**按文件名包含关系**为渠道挑选 APK。
例如 `fileNameIdentify = "huawei"` 时，`xxx-huawei-4.2.0.apk` 会发给华为；不配置则用渠道名（如 `华为`）匹配。

> ⚠️ 配置文件包含各商店密钥：它只存在于你的部署环境（`config/` 已被 `.gitignore` 忽略），
> 接口返回给前端前会自动脱敏，请勿提交到任何仓库。

## 构建功能（打包管理）

「打包管理」在整个任务流中做三件事：同步 Git 分支 → 执行你的构建脚本 → 扫描产物目录。

**启用方式**：把 Android 项目与 SDK 挂进容器，并在应用配置里填好 `build` 段：

```bash
BUILD_PROJECT_DIR=/path/to/your/android/project \
ANDROID_SDK_DIR=/path/to/Android/Sdk \
bash docker_run.sh
```

对应配置：

```json
"build": { "projectRoot": "/app/project", "script": "/app/project/build.sh" }
```

**构建脚本契约**：平台以 `bash <script> <版本号> <更新日志>` 调用脚本，工作目录为 `projectRoot`，并注入环境变量：

| 环境变量 | 说明 |
| --- | --- |
| `OUTPUT_DIR` | **必须使用**：把打好的 APK 放进这个目录（允许子目录），平台递归扫描它 |
| `PROJECT_ROOT` | 项目根目录（同工作目录） |
| `APP_VERSION` / `APP_CHANGELOG` | 版本号 / 更新日志 |
| `ANDROID_SDK_ROOT` / `ANDROID_HOME` | 部署时挂载的 SDK 路径 |
| `JAVA_HOME` | 镜像内置 OpenJDK 17 |

脚本示例见 [`examples/build.sh`](examples/build.sh)。若项目不是 Git 仓库，平台会自动跳过分支同步，直接执行脚本。

## 通知 Webhook

渠道发布页的「推送通知」按钮会把各渠道审核状态 POST 到配置的地址。
地址按特征自动适配：飞书 / 钉钉 / 企业微信机器人开箱即用，其它地址发送通用 JSON：

```json
{ "title": "渠道审核状态汇报（应用名）", "text": "华为：🔄 审核中 (4.2.0)…", "source": "android-publisher", "sentAt": "..." }
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务端口 |
| `BUILD_DATA_ROOT` | `server/data`（容器 `/app/data`） | 数据根目录（APK 归档、任务、日志） |
| `APK_ROOT` | `<数据根>/apks` | APK 归档目录 |
| `CONFIG_DIR` | `config/apps`（容器 `/app/config`） | 应用配置目录；也兼容单文件模式 `CHANNEL_CONFIG_PATH` |
| `WEBHOOK_URL` | 空 | 通知地址（兼容旧名 `FEISHU_WEBHOOK`） |
| `CHANNEL_HTTP_DEBUG` | `false` | 记录渠道 HTTP 请求/响应明细日志（自动脱敏） |
| `CHANNEL_LOG_RETENTION_DAYS` | `30` | 日志保留天数 |
| `CHANNEL_LOG_MAX_SIZE` | `52428800` | 单日志文件上限（字节），超限滚动 |
| `BUILD_DEFAULT_BRANCH` | `main` | 构建页默认分支 |
| `BUILD_PROJECT_ROOT` / `BUILD_RELEASE_RUNNER` | 空 | 单应用部署的兜底构建配置（优先级低于应用配置 `build` 段） |

## 安全说明 ⚠️

当前版本**不内置登录与权限**：任何能访问服务端口的人都可以操作渠道发布（即动用你商店开发者账号的密钥）。
请务必只部署在**内网或受信任网络**；如需公网访问，请置于带鉴权的反向代理之后并启用 HTTPS。

## 当前不做（v0.1 边界）

蒲公英（PGYER）上传、应用商店「首次创建应用 / 上传素材」流程、用户体系与权限、多语言界面。

## 本地开发

```bash
# 依赖
npm --prefix server install
npm --prefix web install

# 后端（:3000）+ 前端热更新（:5173，代理 /api 与 /download 到 3000）
npm run dev:server
npm run dev:web
```

自检方式（项目暂无自动化测试与 lint）：`node --check`（server 全部 JS）与 `npm --prefix web run build`；
接口自测：`curl localhost:3000/api/apps`。

架构与开发约定见 [`PROJECT.md`](PROJECT.md)。

## 许可证

[Apache-2.0](LICENSE) © 2026 SherlockGougou

渠道发布能力与 [小篆传包（XiaoZhuan）](https://github.com/Xigong93/XiaoZhuan) 同源（同为 Apache-2.0），二者共享国内商店接入经验。
