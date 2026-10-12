# AlgoStage 在线体验版镜像
# 构建：docker build --build-arg BASE_PATH=/a1 -t algostage-demo .
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 子路径与体验版开关在构建时写进前端代码
ARG BASE_PATH=""
ARG DEMO="1"
ENV NEXT_PUBLIC_BASE_PATH=$BASE_PATH \
    NEXT_PUBLIC_ALGOSTAGE_DEMO=$DEMO \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL="file:/data/algostage.db"

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY lib/db/database-url.ts ./lib/db/database-url.ts
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
VOLUME /data
CMD ["sh", "deploy/entrypoint.sh"]
