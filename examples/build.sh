#!/usr/bin/env bash
# Android Publisher 构建脚本示例（契约说明，按你的项目实际情况调整）
#
# 调用契约（由平台执行）：
#   bash build.sh <版本号> <更新日志>
#   工作目录：应用配置中的 build.projectRoot
#   环境变量：
#     OUTPUT_DIR        【必须使用】产物输出目录；把打好的 APK 放到这里（可放子目录）
#     PROJECT_ROOT      项目根目录（与工作目录一致）
#     APP_VERSION       版本号（同 $1）
#     APP_CHANGELOG     更新日志（同 $2）
#     ANDROID_SDK_ROOT  Android SDK 路径（若部署时挂载了 SDK）
#     JAVA_HOME         内置 OpenJDK 17 的 JAVA_HOME
#
# 产物命名：
#   各渠道按 fileNameIdentify 在 OUTPUT_DIR 中递归匹配文件名，
#   例如文件名含 "huawei" 的 APK 会发给华为渠道。
set -euo pipefail

VERSION=${1:?缺少版本号参数}
CHANGELOG=${2:-无}
OUTPUT_DIR=${OUTPUT_DIR:?缺少 OUTPUT_DIR 环境变量（由平台注入）}
PROJECT_ROOT=${PROJECT_ROOT:-$(pwd)}
SDK_DIR=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/root/Android/Sdk}}

echo "[build] 版本: $VERSION"
echo "[build] 更新日志: $CHANGELOG"
echo "[build] 项目: $PROJECT_ROOT"
echo "[build] 产物目录: $OUTPUT_DIR"

# 1) 写入 SDK 路径（Gradle 需要）
printf 'sdk.dir=%s\n' "$SDK_DIR" > "$PROJECT_ROOT/local.properties"

# 2) 执行 Gradle 构建（按项目实际情况调整 task）
cd "$PROJECT_ROOT"
./gradlew --no-daemon assembleRelease

# 3) 将 APK 拷贝到 OUTPUT_DIR（示例：单包；多渠道包请在此按渠道分别产出）
mkdir -p "$OUTPUT_DIR"
cp app/build/outputs/apk/release/*.apk "$OUTPUT_DIR/"

echo "[build] 完成，产物已输出到 $OUTPUT_DIR"
