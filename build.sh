#!/bin/bash
# ============================================================================
# 构建 echo-server（配置化版）镜像并推送到 Harbor（在 K8S 节点原生构建 arm64）
#
# 纯 Node ESM 零依赖 → 只需打包 echo-server.mjs + Dockerfile。
#
# ── 用法 ───────────────────────────────────────────────────────────────────
#   bash build.sh [tag]
#   默认 tag = 日期 YYYYMMDD
# ============================================================================
set -euo pipefail

TAG="${1:-$(date +%Y%m%d)}"
SRC_DIR="/e/ai-works/echo-server"
HARBOR="dockerhub.kubekey.local:31104/library"
IMAGE="echo-server:${TAG}"
HARBOR_IMAGE="${HARBOR}/echo-server:${TAG}"
REMOTE_DIR="/tmp/echo-server-build"

echo "════════ 1. 打包构建上下文（零依赖，仅源码）════════"
STAGE="/tmp/echo-server-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"

cp "$SRC_DIR/echo-server.mjs" "$STAGE/"
cp "$SRC_DIR/Dockerfile"      "$STAGE/"

TARBALL="/tmp/echo-server-ctx.tar.gz"
tar -czf "$TARBALL" -C "$STAGE" .
echo "  ✅ 打包完成: $(du -h "$TARBALL" | cut -f1)"

echo
echo "════════ 2. 上传到节点 ════════"
ssh ai-k8s "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR"
scp -q "$TARBALL" ai-k8s:"$REMOTE_DIR/ctx.tar.gz"
ssh ai-k8s "cd $REMOTE_DIR && tar -xzf ctx.tar.gz && rm ctx.tar.gz && ls -la"
echo "  ✅ 上传完成"

echo
echo "════════ 3. 节点上构建镜像（arm64 原生）════════"
ssh ai-k8s "cd $REMOTE_DIR && docker build -t $IMAGE . 2>&1 | tail -15"
echo "  ✅ 构建完成: $IMAGE"

echo
echo "════════ 4. 推送到 Harbor ════════"
ssh ai-k8s "docker tag $IMAGE $HARBOR_IMAGE && docker push $HARBOR_IMAGE 2>&1 | tail -5"
echo "  ✅ 已推送: $HARBOR_IMAGE"

echo
echo "✅ 完成：$HARBOR_IMAGE"
echo "   部署：kubectl -n default set image deploy/echo-server echo-server=$HARBOR_IMAGE"
echo "   并注入 env：ECHO_HOST=echo.ai.ict.cmcc AUTH_HOST=auth.ict.cmcc AUTH_REALM=employees"
