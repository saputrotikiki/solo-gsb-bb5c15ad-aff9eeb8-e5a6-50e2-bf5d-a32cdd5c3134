# ---------- 前端构建 ----------
FROM node:20-alpine AS client-build
WORKDIR /build/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---------- 后端构建 ----------
FROM node:20-alpine AS server-build
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/ ./
RUN npm run build

# ---------- 运行时 ----------
FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data \
    CLIENT_DIST=/app/client/dist
WORKDIR /app

# 仅安装后端生产依赖
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund

COPY --from=server-build /build/server/dist ./server/dist
COPY --from=client-build /build/client/dist ./client/dist

# 数据目录（首次启动时服务会自动初始化示例口令图）
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8080
CMD ["node", "server/dist/index.js"]
