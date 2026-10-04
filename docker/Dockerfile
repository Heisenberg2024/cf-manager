# ============================================================
# CF Manager — All-in-One Docker Image
# 单容器：Node.js 后端 + 前端静态文件（无 nginx）
# ============================================================

# ---- Stage 1: Build Frontend ----
FROM node:24-alpine AS frontend-builder

WORKDIR /app
COPY frontend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/tsconfig*.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/public ./public
COPY frontend/src ./src
RUN npm run build

# ---- Stage 2: Build Backend ----
FROM node:24-alpine AS backend-builder

RUN --mount=type=cache,target=/var/cache/apk apk add --no-cache python3 make g++

WORKDIR /app
COPY backend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY backend/tsconfig.json ./
COPY scripts/gen-version.js ./scripts/gen-version.js
COPY CHANGELOG.md ./CHANGELOG.md
COPY backend/src ./src
# 版本信息：从 CHANGELOG.md 提取版本号，git commit 通过 build-arg 注入（缺省为空）
ARG GIT_COMMIT=""
ENV BACKEND_SRC=/app/src
ENV GIT_COMMIT=${GIT_COMMIT}
RUN node scripts/gen-version.js backend
# model-pricing.json / catalog.schema.json / catalogValidator.ts 均为 .gitignore 的
# 生成产物（来源在 shared/，本地由 scripts/sync-shared.js 生成），Docker 中需手动拷贝。
COPY shared/model-pricing.json ./src/data/model-pricing.json
COPY shared/catalog.schema.json ./src/services/catalog.schema.json
COPY shared/catalogValidator.ts ./src/services/catalogValidator.ts
COPY shared/cfErrors.ts shared/accountDiscovery.ts shared/credentialManager.ts shared/zoneSettings.ts ./src/services/
# catalog 校验器由 ajv standalone 预编译生成（运行时避免 new Function，兼容 Cloudflare）。
COPY scripts/gen-catalog-validator.js ./scripts/gen-catalog-validator.js
RUN CATALOG_SCHEMA_PATH=/app/src/services/catalog.schema.json \
    CATALOG_VALIDATOR_OUT=/app/src/services/catalogValidate.generated.ts \
    node scripts/gen-catalog-validator.js
RUN npx tsc
# Prune dev deps in builder so production just copies clean node_modules
RUN npm prune --omit=dev

# ---- Stage 3: Production (All-in-One) ----
FROM node:24-alpine

WORKDIR /app

# Backend: compiled dist + production node_modules
COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/dist ./dist

# Frontend: built static assets (served by Express via express.static)
COPY --from=frontend-builder /app/dist ./public

RUN mkdir -p /app/data/logs && chown -R node:node /app/data

# su-exec 仅用于用户显式选择 root 启动时的数据卷修复与降权。
# 默认 non-root 启动不调用它，也不需要 CHOWN/SETUID/SETGID capabilities。
RUN apk add --no-cache su-exec
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV PORT=3000
ENV DB_PATH=/app/data/cf-manager.db
ENV LOG_DIR=/app/data/logs

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1

# 默认非 root；显式 --user 0 的传统部署仍可在 entrypoint 中修正数据卷权限。
USER node
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["node", "dist/index.js"]
