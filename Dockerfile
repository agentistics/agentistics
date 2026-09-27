# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# agentistics — multi-stage Docker build
#
# Stage 1 (builder): oven/bun — installs deps, builds web assets, embeds them.
# Stage 2 (runner):  oven/bun — minimal runtime image, SERVE_STATIC=1.
# ---------------------------------------------------------------------------

# ---- Stage 1: build -------------------------------------------------------
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy workspace manifests first for layer-cache efficiency
COPY package.json bun.lock ./
COPY packages/core/package.json      ./packages/core/
COPY packages/runtime/package.json   ./packages/runtime/
COPY packages/server/package.json    ./packages/server/
COPY packages/web/package.json       ./packages/web/
COPY packages/mcp/package.json       ./packages/mcp/
COPY packages/tui/package.json       ./packages/tui/
COPY packages/desktop/package.json   ./packages/desktop/
# The tui depends on `file:./stubs/react-devtools-core` (see packages/tui — the stub is
# load-bearing for the binary build), so bun must be able to link it during install.
COPY packages/tui/stubs               ./packages/tui/stubs

RUN bun install --frozen-lockfile

# Copy the full source
COPY . .

# Build web assets (Vite → packages/web/dist)
RUN bun run build

# Embed web assets into a TypeScript module that the server imports at runtime.
# This generates packages/server/server/embedded-dist.generated.ts
RUN bun run build:assets

# ---- Stage 2: runtime -----------------------------------------------------
FROM oven/bun:1-slim AS runner

WORKDIR /app

# The unprivileged user, created FIRST so this layer caches forever.
#
# It used to be the LAST instruction, and it did `chown -R … /data /app`. Both halves were
# expensive in a way that does not show up until you measure it: the layer sat after
# `COPY --from=builder`, so every source change re-ran it, and `chown -R` over /app walks
# node_modules — ~90 seconds of build time. Worse, a layer records whole files, not metadata
# diffs: rewriting the ownership of every file made this single layer a 370MB duplicate of the
# image below it (1.11GB total for a ~700MB image).
#
# Ownership is now set where it belongs — as the files are copied (`COPY --chown`), which costs
# nothing — and /app itself stays root-owned. The app reads its own code and writes only /data,
# so not owning its code is the property we want anyway.
RUN groupadd --system --gid 10001 agentistics \
 && useradd  --system --uid 10001 --gid agentistics --home-dir /data --shell /usr/sbin/nologin agentistics \
 && mkdir -p /data/.agentistics \
 && chown -R agentistics:agentistics /data

# The TLS trust store, installed EXPLICITLY rather than inherited from the base image.
#
# A central talks to Mongo over TLS (Atlas is `mongodb+srv://…`, certificate-verified). The base
# image happened to ship a usable trust store, so this worked — until a rebuild pulled a newer
# `oven/bun:1-slim` whose store differed, and every Mongo connection began failing with
# "Cert does not contain a DNS name". Same code, same Dockerfile, same commit: only the
# unpinned base had moved. The app served its static assets fine and 500'd on every route that
# touched the database, which reads as data loss rather than as a TLS fault.
#
# Depending on a base image for the trust store is depending on something nobody pinned. Install
# it here so a rebuild cannot silently take it away.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy workspace manifests + lock
COPY package.json bun.lock ./
COPY packages/core/package.json      ./packages/core/
COPY packages/runtime/package.json   ./packages/runtime/
COPY packages/server/package.json    ./packages/server/
COPY packages/web/package.json       ./packages/web/
COPY packages/mcp/package.json       ./packages/mcp/
COPY packages/tui/package.json       ./packages/tui/
COPY packages/desktop/package.json   ./packages/desktop/
# The tui depends on `file:./stubs/react-devtools-core` (see packages/tui — the stub is
# load-bearing for the binary build), so bun must be able to link it during install.
COPY packages/tui/stubs               ./packages/tui/stubs

# Production deps only (no devDependencies). --ignore-scripts skips the root
# `prepare: husky` lifecycle (husky is a devDependency, absent in --production,
# and git hooks are irrelevant in the runtime image).
RUN bun install --frozen-lockfile --production --ignore-scripts

# Copy built source + generated embed. --chown does in the copy what a later `chown -R` would
# have done in a whole extra layer.
COPY --from=builder --chown=agentistics:agentistics /app/packages ./packages

# agentistics runs on port 47291; expose it
EXPOSE 47291

# Run unprivileged: root buys nothing here and costs everything if a process is ever
# compromised. HOME=/data because the server resolves its writable data dir (~/.agentistics)
# from it. (The user itself is created at the top of this stage — see the note there.)
USER agentistics

# SERVE_STATIC=1: server.ts will serve the embedded frontend on the same port.
# AGENTISTICS_TEAM_CENTRAL=1: activate central aggregator mode.
ENV SERVE_STATIC=1 \
    AGENTISTICS_TEAM_CENTRAL=1 \
    PORT=47291 \
    HOME=/data

CMD ["bun", "run", "packages/server/server/index.ts"]
