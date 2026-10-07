FROM oven/bun:1.4.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM oven/bun:1.4.2-alpine
WORKDIR /app
# NOTE: the base image already ships a non-root `bun` user (uid 1000).
COPY --chown=bun:bun --from=deps /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun src ./src
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8899
RUN mkdir -p /app/data && chown bun:bun /app/data
USER bun
EXPOSE 8899
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:${PORT:-8899}/health || exit 1
CMD ["bun", "src/server.ts"]
