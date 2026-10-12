# 构建前端，并保留 Vite 预览服务所需的依赖（本地谱面 API 挂在该服务上）。
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/index.html /app/vite.config.ts /app/tsconfig.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/src ./src
RUN mkdir -p Map .ringmapper-backups && chown -R node:node /app
USER node
EXPOSE 4173
VOLUME ["/app/Map", "/app/.ringmapper-backups"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/auth/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/vite", "preview", "--host", "0.0.0.0", "--port", "4173"]
