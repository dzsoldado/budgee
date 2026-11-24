# The Budgee server: the Bun entry (apps/server/entry/bun.ts) serving the API and the built PWA,
# with its SQLite database on the /data volume. See DEPLOY.md.

# Stage 1: install everything and build the web app.
FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Stage 2: the server's production dependencies, its source and the built web app.
FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/ packages/
COPY apps/server/ apps/server/
COPY apps/web/package.json apps/web/
COPY --from=build /app/apps/web/dist apps/web/dist
RUN bun install --frozen-lockfile --production --filter @budgee/server \
  && mkdir -p /data \
  && chown bun:bun /data
USER bun
ENV HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/data/budgee.sqlite WEB_DIST=/app/apps/web/dist
EXPOSE 8787
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["bun", "-e", "process.exit((await fetch('http://127.0.0.1:8787/api/v1/health')).ok ? 0 : 1)"]
CMD ["bun", "apps/server/entry/bun.ts"]
