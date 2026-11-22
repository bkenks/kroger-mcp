# Remote (HTTP) mode image. Build: docker build -t kroger-mcp .
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
# Port defaults to 3000; set MCP_PORT or PORT (many hosts inject PORT) to change it.
ENV NODE_ENV=production \
    KROGER_MCP_DATA_DIR=/data \
    MCP_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
# Kroger login, OAuth clients/tokens, and preferences live here; keep it on a persistent volume.
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js", "serve"]
