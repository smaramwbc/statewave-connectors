# Official Statewave connectors runner image.
#
# The image bundles `@statewavedev/connectors-cli` (which depends on
# every published connector package and the runner) plus `pg` and
# `ioredis` so any `[runner.state]` kind works out of the box without a
# custom rebuild. Layout:
#
#   /app/node_modules/    — installed packages (CLI binary at .bin/)
#   /app/package.json     — pinned versions, generated at build time
#   /config/              — operators mount their TOML config here (read-only)
#   /state/               — file-backed state lives here (operators mount a volume)
#
# Run:
#   docker run --rm \
#     -p 3000:3000 \
#     -v $PWD/statewave-connectors.toml:/config/statewave-connectors.toml:ro \
#     -v statewave-connectors-state:/state \
#     -e STATEWAVE_URL=https://… \
#     -e STATEWAVE_API_KEY=… \
#     ghcr.io/smaramwbc/statewave-connectors:latest

ARG NODE_IMAGE=node:22-alpine
ARG CLI_VERSION

# ── Stage 1: install ──────────────────────────────────────────────────────
# We use `npm install` (not `pnpm`) here so the image has zero dev-tooling
# carried in: just the runtime CLI, its deps, and the optional state-adapter
# peer deps. CLI_VERSION is a build arg so the image can be pinned to any
# released CLI version (default: latest from the registry).

FROM ${NODE_IMAGE} AS install

ARG CLI_VERSION

WORKDIR /app

# Pin the CLI version. When CLI_VERSION is unset we resolve `latest` so
# `docker build` without args always gives the most recent release.
RUN if [ -n "$CLI_VERSION" ]; then \
      printf '{"name":"statewave-connectors-runner-image","private":true,"dependencies":{"@statewavedev/connectors-cli":"%s","pg":"^8","ioredis":"^5"}}\n' "$CLI_VERSION" > package.json; \
    else \
      printf '{"name":"statewave-connectors-runner-image","private":true,"dependencies":{"@statewavedev/connectors-cli":"latest","pg":"^8","ioredis":"^5"}}\n' > package.json; \
    fi \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ── Stage 2: runtime ──────────────────────────────────────────────────────
# Copy only the install tree from stage 1; never carry the npm cache or
# source-tree noise into the runtime image. Run as a non-root user so a
# future container escape doesn't immediately have UID 0.

FROM ${NODE_IMAGE} AS runtime

# `tini` reaps zombies + handles SIGTERM cleanly. Node's process death
# semantics inside Docker are surprising without an init wrapper.
RUN apk add --no-cache tini \
 && addgroup -S statewave \
 && adduser -S statewave -G statewave \
 && mkdir -p /config /state \
 && chown -R statewave:statewave /state

WORKDIR /app
COPY --from=install --chown=statewave:statewave /app/package.json /app/package.json
COPY --from=install --chown=statewave:statewave /app/node_modules /app/node_modules

USER statewave
EXPOSE 3000
ENV NODE_ENV=production \
    STATEWAVE_CONNECTORS_CONFIG=/config/statewave-connectors.toml

ENTRYPOINT ["/sbin/tini", "--", "/app/node_modules/.bin/statewave-connectors"]
CMD ["run"]
