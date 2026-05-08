# syntax=docker/dockerfile:1.7
#
# statewave-mcp-server image — a stdio MCP server that exposes Statewave
# memory tools to MCP-compatible clients (Claude Desktop, Cursor, etc).
#
# Build context = workspace root. Build with:
#   docker build -f packages/mcp-server/Dockerfile -t statewavedev/statewave-mcp-server .
#
# Two-stage build: the build stage installs deps + compiles; the runtime
# stage carries only the pruned `pnpm deploy --prod` output (mcp-server
# package + its prod transitive deps including the locally built
# connectors-core).

FROM node:20-alpine AS build
WORKDIR /workspace

# pnpm via corepack — version is taken from the root package.json's
# `packageManager` field at activation time.
RUN corepack enable

# Copy workspace manifests + lockfile first for layer caching.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp-server/package.json packages/mcp-server/

# Install only the packages mcp-server depends on (transitive).
# `--frozen-lockfile=false` matches the rest of CI: workspace:^ refs can
# legitimately move ahead of the lockfile during pre-release iteration.
RUN pnpm install --frozen-lockfile=false \
      --filter "@statewavedev/mcp-server..."

# Source for the two packages we actually build.
COPY packages/core packages/core
COPY packages/mcp-server packages/mcp-server

# Build connectors-core first (mcp-server depends on its dist/), then
# mcp-server. `pnpm -r --filter X build` topologically orders by deps.
RUN pnpm -r --filter "@statewavedev/mcp-server..." run build

# Produce a pruned, prod-only tree at /deploy that contains the mcp-server
# package + just its runtime deps. `pnpm deploy` resolves the workspace:^
# reference to connectors-core and copies its dist/ into node_modules.
RUN pnpm --filter @statewavedev/mcp-server deploy --prod /deploy


FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as non-root.
RUN addgroup -S statewave && adduser -S statewave -G statewave
USER statewave

COPY --from=build --chown=statewave:statewave /deploy /app

ENTRYPOINT ["node", "/app/dist/cli.js"]
