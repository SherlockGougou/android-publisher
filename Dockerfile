# Android Publisher 运行镜像
# - 平台本体（server + 已在镜像内构建的 web）开箱可用
# - 「打包管理」需要 JDK 与 Android SDK：镜像内置 OpenJDK 17，SDK 由部署者从宿主机挂载
#   （见 README「Docker 部署 / 构建功能」），或按需扩展本镜像
# - 国内网络可覆盖 BASE_IMAGE，例如 docker.m.daocloud.io/library/node:20-bookworm-slim
ARG BASE_IMAGE=node:20-bookworm-slim
FROM ${BASE_IMAGE}

# Android 构建常用工具链（bash/git/python3 供用户自备的构建脚本使用）
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash curl git python3 openjdk-17-jdk ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sfn /usr/lib/jvm/java-17-openjdk-amd64 /opt/java-17

# 兼容垫片：部分构建脚本会调用 ipconfig / open（Linux 环境不存在）
COPY server/scripts/bin/ipconfig /usr/local/bin/ipconfig
RUN chmod +x /usr/local/bin/ipconfig \
    && printf '#!/bin/sh\nif command -v xdg-open >/dev/null 2>&1; then\n  xdg-open "$@" >/dev/null 2>&1 || true\nelse\n  echo "[open] skip $*"\nfi\n' > /usr/local/bin/open \
    && chmod +x /usr/local/bin/open

# ---- 构建前端 ----
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --prefer-offline
COPY web/ ./
RUN npm run build

# ---- 安装后端依赖 ----
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --prefer-offline --omit=dev
COPY server/ ./

# 运行期目录（建议以卷挂载）：
#   /app/data   → APK 归档、构建/渠道任务数据、日志
#   /app/config → 配置目录，其下 apps/ 放应用 JSON（每个 <applicationId>.json 描述一个应用）
ENV PORT=3000 \
    BUILD_DATA_ROOT=/app/data \
    APK_ROOT=/app/data/apks \
    CONFIG_DIR=/app/config/apps \
    JAVA_HOME=/opt/java-17 \
    ANDROID_HOME=/root/Android/Sdk \
    ANDROID_SDK_ROOT=/root/Android/Sdk

EXPOSE 3000

CMD ["node", "index.js"]
