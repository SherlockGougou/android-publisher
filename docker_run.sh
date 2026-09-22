#!/bin/bash
# 构建并启动 Android Publisher 容器；所有配置均可用同名环境变量覆盖。
#
# 目录约定（相对仓库根目录）：
#   data/   → /app/data          运行数据（APK 归档、任务、日志）
#   config/ → /app/config        配置目录，其下 apps/ 放应用 JSON（<applicationId>.json）
#
# 可选挂载（构建功能）：
#   BUILD_PROJECT_DIR  Android 项目路径            → /app/project
#   ANDROID_SDK_DIR    Android SDK 路径            → /root/Android/Sdk
#   GRADLE_CACHE_DIR   Gradle 缓存（默认 .docker-cache/gradle）→ /root/.gradle
set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# ==================== 配置区 ====================
DOCKER_IMAGE=${DOCKER_IMAGE:-android-publisher:latest}
CONTAINER_NAME=${CONTAINER_NAME:-android-publisher}
HOST_PORT=${HOST_PORT:-3000}
DATA_DIR=${DATA_DIR:-$SCRIPT_DIR/data}
CONFIG_DIR=${CONFIG_DIR:-$SCRIPT_DIR/config}
BUILD_PROJECT_DIR=${BUILD_PROJECT_DIR:-}
ANDROID_SDK_DIR=${ANDROID_SDK_DIR:-}
GRADLE_CACHE_DIR=${GRADLE_CACHE_DIR:-$SCRIPT_DIR/.docker-cache/gradle}
WEBHOOK_URL=${WEBHOOK_URL:-}
CHANNEL_HTTP_DEBUG=${CHANNEL_HTTP_DEBUG:-false}
CHANNEL_LOG_RETENTION_DAYS=${CHANNEL_LOG_RETENTION_DAYS:-30}
CHANNEL_LOG_MAX_SIZE=${CHANNEL_LOG_MAX_SIZE:-52428800}

# ==================== 前置准备 ====================
mkdir -p "$DATA_DIR" "$CONFIG_DIR"

if [ ! -d "$CONFIG_DIR" ] || [ -z "$(ls -A "$CONFIG_DIR" 2>/dev/null)" ]; then
  echo ">>> [warn] 配置目录为空：$CONFIG_DIR（请把应用 JSON 放到 $CONFIG_DIR/apps/，可参考 examples/app.demo.json）"
fi

echo ">>> 构建镜像 $DOCKER_IMAGE ..."
docker build -t "$DOCKER_IMAGE" "$SCRIPT_DIR"

# ==================== 清理旧容器 ====================
if [ -n "$(docker ps -aq -f name="^${CONTAINER_NAME}$")" ]; then
  echo ">>> 停止并删除旧容器 $CONTAINER_NAME ..."
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

# ==================== 运行参数 ====================
RUN_ARGS=(-d --name "$CONTAINER_NAME" --restart unless-stopped
  -p "$HOST_PORT":3000
  -v "$DATA_DIR":/app/data
  -v "$CONFIG_DIR":/app/config:ro
  -e CHANNEL_HTTP_DEBUG="$CHANNEL_HTTP_DEBUG"
  -e CHANNEL_LOG_RETENTION_DAYS="$CHANNEL_LOG_RETENTION_DAYS"
  -e CHANNEL_LOG_MAX_SIZE="$CHANNEL_LOG_MAX_SIZE")

[ -n "$WEBHOOK_URL" ] && RUN_ARGS+=(-e WEBHOOK_URL="$WEBHOOK_URL")

# 构建功能（可选）：项目、SDK、Gradle 缓存
if [ -n "$BUILD_PROJECT_DIR" ]; then
  [ -d "$BUILD_PROJECT_DIR" ] || { echo ">>> 目录不存在: $BUILD_PROJECT_DIR"; exit 1; }
  RUN_ARGS+=(-v "$BUILD_PROJECT_DIR":/app/project)
fi
if [ -n "$ANDROID_SDK_DIR" ]; then
  [ -d "$ANDROID_SDK_DIR" ] || { echo ">>> 目录不存在: $ANDROID_SDK_DIR"; exit 1; }
  RUN_ARGS+=(-v "$ANDROID_SDK_DIR":/root/Android/Sdk:ro)
fi
mkdir -p "$GRADLE_CACHE_DIR"
RUN_ARGS+=(-v "$GRADLE_CACHE_DIR":/root/.gradle)

# git 凭据（仅当构建需要拉取私有仓库时按需挂载；本机存在才挂）
[ -f "$HOME/.gitconfig" ] && RUN_ARGS+=(-v "$HOME/.gitconfig":/root/.gitconfig:ro)
[ -f "$HOME/.git-credentials" ] && RUN_ARGS+=(-v "$HOME/.git-credentials":/root/.git-credentials:ro)

# ==================== 启动 ====================
docker run "${RUN_ARGS[@]}" "$DOCKER_IMAGE" >/dev/null

echo ">>> 已启动: http://localhost:$HOST_PORT"
echo ">>> 数据目录: $DATA_DIR"
echo ">>> 配置目录: $CONFIG_DIR"
[ -n "$BUILD_PROJECT_DIR" ] && echo ">>> 构建项目: $BUILD_PROJECT_DIR → /app/project"
[ -n "$ANDROID_SDK_DIR" ] && echo ">>> Android SDK: $ANDROID_SDK_DIR → /root/Android/Sdk"
