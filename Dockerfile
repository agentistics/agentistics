# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# agentistics — multi-stage Docker build
#
# Stage 0 (engine):  the private engine, EMPTY unless the build is handed one.
# Stage 1 (builder): oven/bun — installs deps, builds web assets, compiles ONE binary.
# Stage 2 (runner):  oven/bun — that binary and nothing else of the source, SERVE_STATIC=1.
#
# THE IMAGE RUNS THE COMPILED BINARY, NOT THE SOURCE. It used to copy `packages/` whole and run
# `bun run packages/server/server/index.ts`; the official image now carries the private engine
# (docs/official-build.md), and an image that ships source would ship the engine's source with it.
# So the runtime stage receives `release/agentop` — `--minify`, no source map — and no source (the one
# `.ts` left in it is a three-line forwarder, below).
# ---------------------------------------------------------------------------

# ---- Stage 0: the engine slot ----------------------------------------------
# A COMMUNITY build (a clone, `docker/central.yml`, `docker/machine.yml`, a fork) leaves this stage
# empty and gets the engine slot `engine-slot.ts` chooses on its own. The OFFICIAL image
# (release.yml's publish-image job) replaces it with the engine checked out at `engine.pin`:
#
#   docker buildx build --build-context engine=.engine --build-arg AGENTISTICS_OFFICIAL=1 .
#
# It is BIND-MOUNTED into the one RUN that compiles, never COPY'd: a bind mount is not a layer, so
# the engine's source exists in no layer of any stage, the builder's included. `.engine/` is also
# in .dockerignore, so `COPY . .` cannot bring it in by the other door.
FROM scratch AS engine

# ---- Stage 1: build -------------------------------------------------------
FROM oven/bun:1 AS builder

# Set by the official build only. With it, an absent engine FAILS the build instead of quietly
# producing a community image under an official tag.
ARG AGENTISTICS_OFFICIAL=""

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

# Embed the web assets, generate the engine slot, compile, and — on the official build — prove the
# result, all in ONE step: it is the only step that can see the engine (a bind mount lives for the
# RUN that declares it, `rw` so `bun install` can write node_modules, and every write is discarded).
# The proof is the release's own smoke test, `assert-official-engine.ts`, run against the very
# binary the runtime stage copies: the engine line names the checked-out engine's version inside
# `engine.pin`'s api range, and none of the three readable-source markers is in its bytes. A failure
# fails the image build, so no image — loaded or pushed — can exist without having passed it.
RUN --mount=type=bind,from=engine,target=/app/.engine,rw \
    set -e; \
    if [ -f .engine/package.json ]; then \
      (cd .engine && AGENTISTICS_PUBLIC_DIR=.. bun install --frozen-lockfile); \
      AGENTISTICS_ENGINE_DIR=.engine bun run build:assets; \
      grep -q "engineSlot = 'dir'" packages/server/server/engine-slot.generated.ts \
        || { echo "the engine slot does not point at the mounted engine" >&2; exit 1; }; \
    elif [ -n "$AGENTISTICS_OFFICIAL" ]; then \
      echo "AGENTISTICS_OFFICIAL is set but no engine was mounted (--build-context engine=<checkout>) — refusing to build an official image without it" >&2; \
      exit 1; \
    else \
      bun run build:assets; \
    fi; \
    mkdir -p release; \
    bun build --compile --minify packages/server/bin/cli.ts --outfile release/agentop; \
    if [ -f .engine/package.json ]; then \
      bun packages/server/scripts/assert-official-engine.ts release/agentop --engine-dir .engine; \
    fi

# ---- Stage 2: runtime -----------------------------------------------------
FROM oven/bun:1-slim AS runner

LABEL org.opencontainers.image.licenses="FSL-1.1-ALv2" \
      org.opencontainers.image.source="https://github.com/agentistics/agentistics"

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

# The binary — the whole server, its dependencies and the embedded web assets in one file. No
# node_modules, no workspace manifests, no source: everything it needs was bundled at compile time.
# Root-owned on purpose, like /app always was: the app reads its own code and writes only /data.
COPY --from=builder /app/release/agentop /usr/local/bin/agentop

# The ONE path older clients still exec. Every `agentop central` released before this image ran
# `docker compose exec app bun run packages/server/bin/cli.ts setup-token` (and `reset-password`,
# `doctor`), as central.sh still does — a path that named the source this image no longer carries.
# It is now a forwarder to the binary, so those commands keep working against a new image.
RUN mkdir -p /app/packages/server/bin \
 && printf '%s\n' \
    '// Forwarder: this image runs the compiled binary. Kept so `bun run packages/server/bin/cli.ts <cmd>` still works.' \
    "const r = Bun.spawnSync(['/usr/local/bin/agentop', ...process.argv.slice(2)], { stdio: ['inherit', 'inherit', 'inherit'] })" \
    'process.exit(r.exitCode ?? 1)' \
    > /app/packages/server/bin/cli.ts

# agentistics runs on port 47291; expose it
EXPOSE 47291

# Run unprivileged: root buys nothing here and costs everything if a process is ever
# compromised. HOME=/data because the server resolves its writable data dir (~/.agentistics)
# from it. (The user itself is created at the top of this stage — see the note there.)
USER agentistics

# SERVE_STATIC=1: server.ts will serve the embedded frontend on the same port.
# AGENTISTICS_TEAM_CENTRAL=1: activate central aggregator mode.
# AGENTISTICS_CONTAINER=1: no event producer, no scheduled backup, no self-upgrade (daemon-plan.ts,
# upgrade-gate.ts) — an image is replaced, not upgraded in place.
ENV SERVE_STATIC=1 \
    AGENTISTICS_CONTAINER=1 \
    AGENTISTICS_TEAM_CENTRAL=1 \
    PORT=47291 \
    HOME=/data

# `agentop server` — the server, plus only the parts of the daemon a central or a container should run
# (packages/server/server/daemon-plan.ts: a central starts none of it). `bun` stays in the image only for the
# healthchecks in docker/*.yml (`bun -e "fetch(...)"`) and the forwarder above.
CMD ["agentop", "server"]
