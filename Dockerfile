# AlgoStage 自托管镜像
# 构建：docker build --build-arg BASE_PATH=/a1 -t algostage .
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 子路径在构建时写进前端代码
ARG BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$BASE_PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    DATA_DIR="/data" \
    DATABASE_URL="file:/data/algostage.db"

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY lib/db/database-url.ts ./lib/db/database-url.ts
COPY lib/judge ./lib/judge
COPY scripts/build-judge.ts ./scripts/build-judge.ts
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production
RUN groupadd --gid 1001 algostage \
  && useradd --uid 1001 --gid algostage --home-dir /app --no-create-home --shell /usr/sbin/nologin algostage \
  && mkdir -p /data \
  && chown -R algostage:algostage /app/.next /data

EXPOSE 3000
VOLUME /data
# 注意：algostage 用户的 HOME=/app，对 uid 1001 不可写（只有 /app/.next、/data 可写）。
# 以后新增会写 HOME 的依赖（npm cache、~/.cache 等），需显式指定可写目录（如 /tmp 或 /data 下的子目录）。
USER 1001:1001
CMD ["sh", "deploy/entrypoint.sh"]
