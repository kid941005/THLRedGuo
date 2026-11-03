# 红果 Docker 网页版镜像
#
# 构建（在仓库根目录执行）：
#   docker build -f server/Dockerfile -t thlredguo-gateway .
#
# 运行：
#   docker run -d --name thlredguo-gateway -p 8080:8080 thlredguo-gateway
#
# 说明：
#  - 镜像内包含两份代码：server/gateway.js（本仓库）与 server/vendor/hongguo-web（MIT 第三方）
#  - 只暴露 8080；内置服务仅在容器内 127.0.0.1:8000 监听
#  - 不使用多阶段构建：无编译产物、无第三方 npm 依赖

FROM node:24-alpine

# Required for tail-moov remux and optional H.264 browser transcoding.
RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production \
    PORT=8080 \
    HK_PORT=8000 \
    HG_TRANSCODE=0 \
    HONGGUO_DATA_DIR=/app/data \
    HONGGUO_STREAM_CACHE=/app/data/stream-cache \
    CACHE_TTL_MIN=180 \
    CACHE_MAX_MB=2048 \
    HONGGUO_CACHE_MAX_FILES=0 \
    TZ=Asia/Shanghai

WORKDIR /app

# 网页、网关与内置取流服务
COPY server/ /app/server/

# 兜底：即使 .dockerignore 被绕过，也不让本地运行期生成的设备身份/密钥进入镜像
# （镜像会推到公开的 GHCR，这种文件一旦进去等于泄露 device_id 与 api key）
RUN rm -f /app/server/vendor/hongguo-web/server/config/apikeys.json \
    && rm -rf /app/server/vendor/hongguo-web/server/stream-cache

# 设备身份备份与解密缓存目录（必须挂卷，容器重建后靠它还原 device_id）
RUN mkdir -p /app/data /app/server/vendor/hongguo-web/download
VOLUME ["/app/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "/app/server/gateway.js"]
