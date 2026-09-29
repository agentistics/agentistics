/**
 * cli-central.ts — the `agentop central …` command handler.
 *
 * Two paths, chosen automatically:
 *
 *  1. REPO path — when a `central.sh` is found in the agentistics checkout (dev, or running
 *     `agentop central` from inside the repo). We just shell out to that script, inheriting
 *     stdio so its interactive prompts and log streaming work naturally. Behavior unchanged.
 *
 *  2. STANDALONE path — the compiled binary run from ANY directory, with no repo present.
 *     We can't build the image from source, so we materialize a small Docker Compose that
 *     PULLS the published central image (ghcr.io/agentistics/agentistics:<version>) into
 *     ~/.agentistics/central/, generate central.env interactively on first run, and drive
 *     `docker compose` directly — no repo, no clone required.
 *
 * Either path can also be STREAMED (`CentralRunOptions.streamed`), which is how the control center
 * runs it: children are piped instead of inheriting the terminal, so their output can be shown
 * inside a pane rather than over the frame Ink is painting. A streamed run asks NOTHING — see
 * `planCentralStart`, which is how a caller knows whether the action it wants has a question in it.
 */

import { existsSync } from 'fs'
import { mkdir, writeFile, chmod } from 'fs/promises'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { version as APP_VERSION } from '../../../package.json'
import { input, confirm, select } from './cli-ui'
import { createChunkSink, pumpStream } from './cli-stream'
import { parseRebuildFlags } from './rebuild-flags'
import {
  CENTRAL_RUNTIMES,
  centralRuntimeOptions,
  flagFor,
  parseCentralUpFlags,
  parseStoredRuntime,
  resolveCentralRuntime,
  RUNTIME_ENV_KEY,
  type CentralRuntimeBlock,
  type CentralRuntimeFacts,
  type CentralRuntimeId,
  type CentralRuntimeOption,
  type CentralStartHow,
} from './central-runtime'
import {
  bindWarning,
  reachOfExisting,
  settingsForReach,
  type CentralReach,
  type ExposureProfile,
} from './central-reach'

/** The central.sh subcommands this handler forwards / implements. */
export const CENTRAL_ACTIONS = ['up', 'init', 'down', 'logs', 'status', 'restart', 'pull', 'setup-token', 'reset-password'] as const
export type CentralAction = (typeof CENTRAL_ACTIONS)[number]

export function isCentralAction(value: string): value is CentralAction {
  return (CENTRAL_ACTIONS as readonly string[]).includes(value)
}

/** Published central image. The tag defaults to this binary's version so the central matches
 *  the CLI; override with AGENTISTICS_IMAGE (e.g. to pin :latest or a specific build). */
const IMAGE = process.env.AGENTISTICS_IMAGE || `ghcr.io/agentistics/agentistics:${APP_VERSION}`
const PROJECT = process.env.PROJECT || 'team-mode'
const STANDALONE_DIR = join(homedir(), '.agentistics', 'central')

/**
 * Best-effort repo root that contains central.sh.
 *
 * ASSUMPTION: this file lives at `<repoRoot>/packages/server/server/cli-central.ts`,
 * so the repo root is three directories up from `import.meta.dir`. When running
 * from the compiled binary that path won't hold central.sh; the CWD is tried as
 * a fallback so `agentop central …` works when invoked from a checkout.
 */
function findCentralScript(): string | null {
  const candidates: string[] = []
  try {
    candidates.push(resolve(import.meta.dir, '..', '..', '..', 'central.sh'))
  } catch { /* import.meta.dir unavailable — skip */ }
  candidates.push(resolve(process.cwd(), 'central.sh'))
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * How a central command is allowed to talk.
 *
 * `streamed` is set by the control center, which is drawing into the alternate screen: an inherited
 * child would write straight onto the frame Ink is repainting. The child then gets NO stdin either,
 * which is what makes central.sh take its non-interactive path (`[ -t 0 ]` is false) — see
 * `planCentralStart`, which is how the caller knows in advance that this is safe for the action it
 * is about to run.
 */
export interface CentralRunOptions {
  streamed?: boolean
  /**
   * Native `up` only: start detached instead of taking over the terminal.
   *
   * `runNativeCentral`'s normal `up` blocks in the foreground forever (Ctrl-C to stop) — the only
   * shape it has ever had, because `agentop central up` on a real terminal is exactly that. The
   * control center's "start in the background" option needs the other shape: return immediately,
   * with the server running detached and its output going to a log file instead of this terminal.
   * Ignored by every other action and by the Docker paths, which have their own `-d`.
   */
  detached?: boolean
}

/** stdio for a child, in the two modes: the user's terminal, or the control center's pane. */
function childIo(streamed: boolean) {
  return streamed
    ? { stdin: 'ignore' as const, stdout: 'pipe' as const, stderr: 'pipe' as const }
    : { stdin: 'inherit' as const, stdout: 'inherit' as const, stderr: 'inherit' as const }
}

/**
 * Wait for a child, publishing its piped output when there is any.
 *
 * One sink per stream — stdout and stderr are read concurrently, and a shared decoder would splice
 * a half-line of one into the other.
 */
async function awaitChild(proc: Bun.Subprocess, streamed: boolean): Promise<number> {
  if (!streamed) return proc.exited
  const out = createChunkSink()
  const err = createChunkSink()
  try {
    await Promise.all([
      pumpStream(proc.stdout as ReadableStream<Uint8Array> | null, out),
      pumpStream(proc.stderr as ReadableStream<Uint8Array> | null, err),
    ])
    return await proc.exited
  } finally {
    out.flush()
    err.flush()
  }
}

/**
 * Run `bash <repoRoot>/central.sh <action> ...extraArgs`. Returns the child's exit code.
 *
 * Normally it inherits stdio, so its interactive prompts and its log streaming pass straight
 * through. Streamed, its output is published as pane lines instead and it gets no stdin.
 */
async function runCentralRepo(
  script: string,
  action: string,
  extraArgs: string[],
  opts: CentralRunOptions,
): Promise<number> {
  const streamed = opts.streamed === true
  try {
    const proc = Bun.spawn(['bash', script, action, ...extraArgs], childIo(streamed))
    return await awaitChild(proc, streamed)
  } catch (err) {
    process.stderr.write(
      `Could not run central.sh: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
}

/** Is `docker` on PATH? Cheap, and the only prerequisite either Docker runtime has. */
async function hasDocker(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['docker', '--version'], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

/** Where this box keeps the central's config: beside `central.sh` in a checkout, else the
 *  standalone directory. It follows the CHECKOUT, not the runtime — choosing `--image` inside a
 *  repo still configures that repo's central, rather than silently starting a different one. */
function centralEnvFile(script: string | null): string {
  return script ? repoEnvFile(script) : join(STANDALONE_DIR, 'central.env')
}

/** Everything `resolveCentralRuntime` needs, gathered from this box. */
export async function centralRuntimeFacts(): Promise<CentralRuntimeFacts> {
  const script = findCentralScript()
  const envFile = centralEnvFile(script)
  const exists = existsSync(envFile)
  return {
    script: Boolean(script),
    docker: await hasDocker(),
    envFile: exists,
    mongoUrl: exists ? (await readEnvValue(envFile, 'MONGO_URL')) ?? '' : '',
  }
}

/** The runtime this central is CONFIGURED with, when its env file records one. */
export async function storedCentralRuntime(): Promise<CentralRuntimeId | undefined> {
  const envFile = centralEnvFile(findCentralScript())
  if (!existsSync(envFile)) return undefined
  return parseStoredRuntime(await readEnvValue(envFile, RUNTIME_ENV_KEY))
}

/** The runtimes this box can offer, for a surface that wants to list them (the CLI's picker, the
 *  control center's start verbs). One resolution, two front doors. */
export async function centralRuntimeChoices(): Promise<CentralRuntimeOption[]> {
  return centralRuntimeOptions(await centralRuntimeFacts())
}

/** One line saying why a runtime cannot be used here. English — this is the CLI's own voice; the
 *  control center renders the same codes through its own strings. */
export function centralRuntimeBlockText(
  id: CentralRuntimeId,
  reason: CentralRuntimeBlock | 'none-available',
): string {
  switch (reason) {
    case 'no-docker':
      return `${flagFor(id)} needs Docker, and \`docker\` is not on PATH here.`
    case 'no-checkout':
      return `${flagFor(id)} builds the image from source, and there is no agentistics checkout here. ` +
        'Use --image to run the published one instead, or run this from a clone of the repository.'
    case 'no-env':
      return 'This central is not configured yet — run `agentop central init` first.'
    case 'bundled-mongo':
      return `${flagFor(id)} runs the server itself, with no Docker and no bundled database, so it needs ` +
        'an external MONGO_URL (Atlas, or a Mongo you run yourself). Re-run `agentop central init` ' +
        'and choose the external-URI option to switch.'
    case 'none-available':
      return 'Nothing on this box can run a central: there is no Docker, and no external database ' +
        'is configured for a native one. Install Docker, or run `agentop central init` and point ' +
        'MONGO_URL at an external cluster.'
  }
}

/**
 * Dispatch a central action, under the runtime the user asked for or the one this box defaults to.
 *
 * The runtime used to be pure inference — a checkout meant `central.sh`, no checkout meant the
 * published image — which made two perfectly reasonable requests impossible to express: running
 * the published image from inside a clone, and running the server natively anywhere. It is now
 * `central-runtime.ts`'s decision, taken from `--image` / `--build` / `--native`, else from the
 * `AGENTISTICS_CENTRAL_RUNTIME` the setup wizard recorded, else from the same default the old
 * inference produced (which `central-runtime.test.ts` pins against `planCentralStart`).
 *
 * A REQUESTED runtime that cannot work here is refused in a sentence, never downgraded: a
 * `--native` that quietly became a Docker start would be a central running under a shape its
 * operator did not choose, with nothing on screen saying so.
 */
export async function runCentral(
  action: string,
  extraArgs: string[],
  opts: CentralRunOptions = {},
): Promise<number> {
  if (!isCentralAction(action)) {
    process.stderr.write(
      `Invalid central action: ${action}. Expected one of: ${CENTRAL_ACTIONS.join(', ')}.\n`,
    )
    return 1
  }

  const parsed = parseCentralUpFlags(extraArgs)
  if (!parsed.ok) {
    process.stderr.write(`${parsed.conflict[0]} and ${parsed.conflict[1]} contradict each other — pass one.\n`)
    return 1
  }
  const { runtime: requested, how } = parsed.flags
  const rest = parsed.rest

  const script = findCentralScript()
  const envFile = centralEnvFile(script)

  // `init` is what CREATES the configuration the resolution below reads, so it can never be gated
  // on it. It runs wherever the env file lives, on either path.
  if (action === 'init') {
    if (script) return runCentralRepo(script, action, rest, opts)
    return runCentralStandalone('init', rest, opts, 'docker-image')
  }

  const facts = await centralRuntimeFacts()
  const stored = facts.envFile
    ? parseStoredRuntime(await readEnvValue(envFile, RUNTIME_ENV_KEY))
    : undefined
  const resolution = resolveCentralRuntime(requested ?? stored, facts)

  if (!resolution.ok) {
    // An `up` on an UNCONFIGURED box is not a failure — it is the first run, and the standalone
    // path's own flow offers to create central.env. Only a genuine impossibility stops here.
    if (resolution.reason === 'no-env' && action === 'up') {
      return runCentralStandalone(action, rest, opts, 'docker-image', how)
    }
    process.stderr.write(`${centralRuntimeBlockText(resolution.id ?? 'docker-image', resolution.reason)}\n`)
    return 1
  }

  switch (resolution.id) {
    case 'docker-build':
      // central.sh owns this path entirely, including its own overlay selection and its prompts.
      return runCentralRepo(script!, action, rest, opts)
    case 'docker-image':
    case 'native':
      return runCentralStandalone(action, rest, opts, resolution.id, how)
  }
}

// ---------------------------------------------------------------------------
// What a `central up` would DO here — asked before it is run
// ---------------------------------------------------------------------------

/**
 * The four shapes a `central up` can take on a given box.
 *
 * The distinction the control center needs is not "repo or image" but "does this need the real
 * TERMINAL": `init` asks questions (central.sh refuses outright without a tty) and `native` becomes
 * a foreground server that never exits, so both must keep the `suspend` path. `script` and `image`
 * are pure docker compose runs with no question in them, which is exactly what a streaming pane is
 * for.
 */
export type CentralStartPlan = 'script' | 'image' | 'native' | 'init'

/**
 * PURE: which shape a `central up` takes, given what is on disk.
 *
 * A missing env file leads, whichever path we are on: both central.sh and the standalone path
 * generate it interactively on first run, and that is a question rather than a build.
 */
export function planCentralStart(facts: {
  /** A `central.sh` was found. */
  script: boolean
  /** Its env file — `central.env` — exists. */
  envFile: boolean
  /** The env file's `MONGO_URL`, for deciding Docker versus native. */
  mongoUrl: string
}): CentralStartPlan {
  if (!facts.envFile) return 'init'
  // central.sh drives compose either way: with an external DB it merely leaves the bundled Mongo
  // out. Only the standalone path can end up running the binary itself.
  if (facts.script) return 'script'
  return isBundledMongo(facts.mongoUrl) ? 'image' : 'native'
}

/** The env file central.sh would read: beside the script, honoring an ENV_FILE override. */
function repoEnvFile(script: string): string {
  return resolve(dirname(script), process.env.ENV_FILE || 'central.env')
}

/** `planCentralStart`, with the facts gathered from this box. */
export async function centralStartPlan(): Promise<CentralStartPlan> {
  const script = findCentralScript()
  const envFile = script ? repoEnvFile(script) : join(STANDALONE_DIR, 'central.env')
  const exists = existsSync(envFile)
  return planCentralStart({
    script: Boolean(script),
    envFile: exists,
    mongoUrl: exists ? (await readEnvValue(envFile, 'MONGO_URL')) ?? '' : '',
  })
}

// ---------------------------------------------------------------------------
// Standalone path — no repo, pull the published image
// ---------------------------------------------------------------------------

/**
 * Compose file that PULLS the published image instead of building from source — the no-repo path.
 *
 * It is the twin of `docker/central.image.yml` in the repository, and `standalone-compose.test.ts`
 * holds them to that: every `AGENTISTICS_*` variable, the data-volume mount path and the bind
 * default must match. The test exists because BOTH of those went wrong here while the repo file
 * was right, and neither failure was visible from the outside:
 *
 *  • None of the exposure variables were passed through, so `AGENTISTICS_EXPOSURE=public` in
 *    central.env did nothing at all. The instance kept the `lan` profile — local shell, local chat
 *    and the host transcript readers all reachable — while its operator had configured it as
 *    public and had no way to tell from the app.
 *  • The data volume was mounted at /root/.agentistics while the image runs as uid 10001 with
 *    HOME=/data, so the app wrote to the container's own writable layer. Every `agentop central
 *    up` passes `--force-recreate`, which is exactly what throws that layer away: the archive
 *    consent gate reappeared on a central that had already answered it, and the sync state was
 *    rebuilt from nothing each time.
 *
 * Host harness dirs are intentionally NOT mounted (self-contribution is a repo/advanced feature),
 * so a dedicated central never fails on a missing ~/.codex and an exposed one is not holding
 * every raw transcript on the machine. Values come from central.env.
 */
export const STANDALONE_COMPOSE = `# Generated by \`agentop central\` — pulls the published central image (no repo needed).
# Managed file: re-created on each \`agentop central up\`. Edit central.env, not this file.
# Its reviewable source is docker/central.image.yml in the agentistics repository.
name: team-mode

services:
  app:
    image: \${AGENTISTICS_IMAGE:-ghcr.io/agentistics/agentistics:latest}
    environment:
      MONGO_URL: \${MONGO_URL:-mongodb://mongo:27017/?replicaSet=rs0}
      MONGO_DB: \${MONGO_DB:-agentistics}
      AGENTISTICS_TEAM_CENTRAL: "1"
      AGENTISTICS_TEAM_ORG: \${AGENTISTICS_TEAM_ORG:-default}
      AGENTISTICS_TEAM_PASSWORD: \${AGENTISTICS_TEAM_PASSWORD:-}
      AGENTISTICS_TEAM_SESSION_SECRET: \${AGENTISTICS_TEAM_SESSION_SECRET:-}
      AGENTISTICS_TEAM_INGEST_TOKEN: \${AGENTISTICS_TEAM_INGEST_TOKEN:-}
      # Exposure — every one of these must be reachable from central.env, or a documented
      # setting silently does nothing. See docs/exposure.md.
      AGENTISTICS_EXPOSURE: \${AGENTISTICS_EXPOSURE:-}
      AGENTISTICS_ALLOW_LOCAL_SHELL: \${AGENTISTICS_ALLOW_LOCAL_SHELL:-}
      AGENTISTICS_TRUST_PROXY: \${AGENTISTICS_TRUST_PROXY:-}
      AGENTISTICS_TEAM_TLS: \${AGENTISTICS_TEAM_TLS:-}
      AGENTISTICS_ALLOWED_ORIGINS: \${AGENTISTICS_ALLOWED_ORIGINS:-}
      AGENTISTICS_INGEST_ONLY: \${AGENTISTICS_INGEST_ONLY:-}
      AGENTISTICS_OIDC_AUDIENCE: \${AGENTISTICS_OIDC_AUDIENCE:-}
      AGENTISTICS_OIDC_ISSUER: \${AGENTISTICS_OIDC_ISSUER:-}
      # Names the tool that started this container, so the in-container "lost your setup token"
      # banner can suggest a command this host actually has.
      AGENTISTICS_DEPLOY_HINT: "agentop"
      PORT: "47291"
      SERVE_STATIC: "1"
    ports:
      # Loopback by default: a generated file must never be what puts a central on the network.
      - "\${BIND_IP:-127.0.0.1}:\${APP_PORT:-48080}:47291"
    volumes:
      # /data/.agentistics — the image runs as uid 10001 with HOME=/data (see Dockerfile).
      - agentistics_data:/data/.agentistics
    user: "10001:10001"
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    healthcheck:
      test: ["CMD", "bun", "-e", "const r = await fetch('http://127.0.0.1:47291/api/health'); process.exit(r.ok ? 0 : 1)"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    restart: unless-stopped

volumes:
  agentistics_data:
`

/**
 * The bundled-Mongo overlay, merged only when MONGO_URL targets the internal `mongo` service —
 * the same rule `central.sh` applies with `docker/central.localdb.yml`, and the reason `app`
 * above carries no `depends_on`: with an external cluster there is no local Mongo to depend on,
 * and a `depends_on` naming a service no compose file defines is a hard error rather than a
 * skipped condition.
 */
export const STANDALONE_LOCALDB_COMPOSE = `# Generated by \`agentop central\` — the bundled MongoDB.
# Managed file: re-created on each \`agentop central up\`. Edit central.env, not this file.
# Its reviewable source is docker/central.localdb.yml in the agentistics repository.
services:
  mongo:
    image: mongo:7
    command: --replSet rs0
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "try { rs.status() } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] }) }"]
      interval: 10s
      timeout: 10s
      retries: 10
      start_period: 20s
    # mongo is NOT published to the host — only the app service reaches it.
    volumes:
      - mongo_data:/data/db

  app:
    depends_on:
      mongo:
        condition: service_healthy

volumes:
  mongo_data:
`

const hex = (bytes: number) => randomBytes(bytes).toString('hex')

export interface CentralEnvOpts {
  port?: string
  org?: string
  /** When omitted, a random session secret is generated. */
  sessionSecret?: string
  ingestToken?: string
  bind?: string
  /** External Mongo connection string (Atlas/remote). When set, the central runs NATIVELY (no
   *  Docker, no bundled Mongo). When omitted, the bundled Docker Mongo service is used. */
  mongoUrl?: string
  /**
   * The exposure profile — what this instance is ALLOWED to do, given who can reach it.
   *
   * Written by the wizard from its "who will reach this central" question. It is the single most
   * consequential setting on a central and used to be reachable only by hand-editing this file
   * after reading a document, so a central deployed behind a tunnel silently kept the `lan`
   * profile with its host-power routes live.
   */
  exposure?: ExposureProfile
  /** TLS terminates in front of this instance: Secure + __Host- cookies, and HSTS. */
  tls?: boolean
  /** Believe CF-Connecting-IP / X-Forwarded-For. Only ever alongside a loopback bind. */
  trustProxy?: boolean
  /** How this central is brought up here. Recorded so every later `up`, `restart`, `logs` and
   *  `status` resolves the same way the first one did — otherwise the answer would be re-inferred
   *  from what happens to be on disk, and a central deployed from the published image would start
   *  building from source the day someone cloned the repo beside it. */
  runtime?: CentralRuntimeId
}

/** Connection string for the bundled Docker Mongo service (single-node replica set). */
export const BUNDLED_MONGO_URL = 'mongodb://mongo:27017/?replicaSet=rs0'

/** True when MONGO_URL targets the bundled Docker `mongo` service (→ run via Docker), as opposed
 *  to an external URI like Atlas (→ run natively, no Docker). Pure. */
export function isBundledMongo(mongoUrl: string): boolean {
  return /(?:\/\/|@)mongo:\d+/.test(mongoUrl)
}

/** Cheap validation that a string is a Mongo connection URI. Pure. */
export function looksLikeMongoUri(raw: string): boolean {
  return /^mongodb(\+srv)?:\/\/\S+/.test(raw.trim())
}

/**
 * Build the central.env contents (pure). Applies defaults (port 48080, org 'default',
 * bind 0.0.0.0) and auto-generates the session secret when not supplied.
 * Kept side-effect-free (except crypto randomness) so it is unit-testable.
 *
 * NO shared dashboard password is generated: a central authenticates ACCOUNTS
 * (owner → members), created on first boot through the one-time setup token the server
 * prints to its log. `AGENTISTICS_TEAM_PASSWORD` is the legacy pre-accounts gate and is not
 * part of this flow — writing one only makes the operator believe it is a credential they
 * need to keep and share.
 */
export function buildCentralEnv(opts: CentralEnvOpts = {}): string {
  const port = opts.port || '48080'
  // Loopback, not 0.0.0.0. A generated file must never be the thing that puts a central on the
  // network: the compose files default to 127.0.0.1 for exactly that reason, and a wizard writing
  // 0.0.0.0 over the top of them made the documented default a fiction. Widening it is a line the
  // operator edits, or an answer they give the prompt — never one they inherit.
  const bind = opts.bind || '127.0.0.1'
  const org = opts.org || 'default'
  const sessionSecret = opts.sessionSecret || hex(32)
  const ingest = opts.ingestToken ?? ''
  const mongoUrl = opts.mongoUrl?.trim() || BUNDLED_MONGO_URL
  const runtime = opts.runtime
  const exposure = opts.exposure ?? 'lan'
  return (
    `# agentistics Team Mode — generated by \`agentop central\`. Holds secrets; keep it private.\n` +
    `APP_PORT=${port}\n` +
    `BIND_IP=${bind}\n` +
    `MONGO_URL=${mongoUrl}\n` +
    `MONGO_DB=agentistics\n` +
    `AGENTISTICS_TEAM_CENTRAL=1\n` +
    `AGENTISTICS_TEAM_ORG=${org}\n` +
    `AGENTISTICS_TEAM_SESSION_SECRET=${sessionSecret}\n` +
    `AGENTISTICS_TEAM_INGEST_TOKEN=${ingest}\n` +
    `AGENTISTICS_CENTRAL_USER=\n` +
    (runtime
      ? `# Read by the agentop CLI only — no compose passes it into the container.\n` +
        `${RUNTIME_ENV_KEY}=${runtime}\n`
      : '') +
    `# Exposure — what this instance is ALLOWED to do, given who can reach it. See\n` +
    `# docs/exposure.md. \`public\` permanently revokes the local-shell, local-chat,\n` +
    `# host-transcript and MCP-admin routes; an unknown value fails closed to \`public\`.\n` +
    `AGENTISTICS_EXPOSURE=${exposure}\n` +
    (opts.tls ? `AGENTISTICS_TEAM_TLS=1\n` : '') +
    (opts.trustProxy
      ? `# Correct only because BIND_IP is loopback: the proxy in front is provably the only\n` +
        `# way in, so its client-IP header can be believed.\n` +
        `AGENTISTICS_TRUST_PROXY=1\n`
      : '')
  )
}

/** docker compose for the standalone central, with project + env-file + compose-file pre-set. */
function composeArgs(envFile: string, composeFiles: readonly string[], rest: string[]): string[] {
  const files = composeFiles.flatMap(f => ['-f', f])
  return ['docker', 'compose', '-p', PROJECT, '--env-file', envFile, ...files, ...rest]
}

async function runCompose(
  envFile: string,
  composeFiles: readonly string[],
  rest: string[],
  opts: CentralRunOptions = {},
): Promise<number> {
  const streamed = opts.streamed === true
  try {
    const proc = Bun.spawn(composeArgs(envFile, composeFiles, rest), {
      ...childIo(streamed),
      // Plain progress while streamed: docker's fancy renderer redraws its step table with cursor
      // moves, which a pane cannot hold — see cli-stream.ts.
      env: {
        ...process.env,
        AGENTISTICS_IMAGE: IMAGE,
        ...(streamed ? { NO_COLOR: '1', BUILDKIT_PROGRESS: 'plain' } : {}),
      },
    })
    return await awaitChild(proc, streamed)
  } catch (err) {
    process.stderr.write(
      `Could not run docker compose: ${err instanceof Error ? err.message : String(err)}\n` +
      'Is Docker installed and running?\n',
    )
    return 1
  }
}

/** The human name of each runtime, for the picker and for anything reporting what it will do. */
export function centralRuntimeLabel(id: CentralRuntimeId): string {
  switch (id) {
    case 'docker-image': return 'Docker, published image — pulls ghcr.io/agentistics/agentistics (no checkout needed)'
    case 'docker-build': return 'Docker, built from this checkout — central.sh, the image is built here'
    case 'native': return 'Native — the agentop binary IS the server (no Docker; needs an external database)'
  }
}

/**
 * Ask HOW this central should run, listing only what this box can actually do.
 *
 * An unavailable runtime is stated in a SENTENCE above the list rather than offered and refused.
 * A row that cannot be picked explains nothing on its own, and a row that can be picked and then
 * fails is worse — it is a verb the screen promised. The same rule the control center applies to a
 * rebuild it cannot perform.
 *
 * With exactly one option there is no question to ask: it is announced and taken.
 */
async function askRuntime(facts: CentralRuntimeFacts, fallback: CentralRuntimeId): Promise<CentralRuntimeId> {
  const options = centralRuntimeOptions(facts)
  const available = options.filter(o => o.available)
  const blocked = options.filter(o => !o.available)

  if (blocked.length > 0) {
    process.stdout.write('\n  Not available on this machine:\n')
    for (const o of blocked) {
      process.stdout.write(`    - ${flagFor(o.id)}: ${centralRuntimeBlockText(o.id, o.reason!)}\n`)
    }
  }
  if (available.length === 0) return fallback
  if (available.length === 1) {
    process.stdout.write(`\n  How it runs: ${centralRuntimeLabel(available[0]!.id)}\n`)
    return available[0]!.id
  }

  return select<CentralRuntimeId>({
    message: 'How should this central run',
    choices: available.map(o => ({ name: centralRuntimeLabel(o.id), value: o.id })),
  })
}

/** Interactively generate central.env (secrets auto-filled). Called on first `up`, or `init`. */
async function initEnv(envFile: string): Promise<void> {
  process.stdout.write(`\nSetting up ${envFile} — press Enter to accept the [default] / auto-generate.\n\n`)
  const existing = existsSync(envFile) ? await loadEnvFile(envFile) : {}
  const port = await input('Host port (APP_PORT)', { default: existing.APP_PORT || '48080' })
  const org = await input('Org name (AGENTISTICS_TEAM_ORG)', { default: existing.AGENTISTICS_TEAM_ORG || 'default' })
  // WHO WILL REACH IT — the question the wizard did not ask, and the one that decides the most.
  //
  // It was previously only a BIND_IP prompt, which asks where the socket listens and says nothing
  // about what the app may DO for whoever arrives. Those are different questions: a central behind
  // a tunnel and a central nobody can reach look identical from inside the container (both bind
  // loopback), so the profile cannot be inferred and had to be hand-written into central.env after
  // reading a document. In practice nobody did, and centrals went onto the internet running the
  // `lan` profile with their host-power routes live.
  process.stdout.write(
    '\n  This decides what the central is ALLOWED to do, not just where it listens: an instance\n' +
    '  strangers can reach permanently loses the routes that run a shell, open a chat CLI and\n' +
    '  read this host\'s transcripts.\n',
  )
  const reachChoices: { name: string; value: CentralReach }[] = [
    { name: 'Only this machine — nothing else can connect', value: 'this-host' },
    { name: 'A network I trust — LAN, or a tailnet', value: 'trusted-network' },
    { name: 'The internet — published through a tunnel or a reverse proxy', value: 'internet' },
  ]
  // Re-running the wizard lands on what this central already is, never on a fresh install's answer.
  const currentReach = reachOfExisting({ exposure: existing.AGENTISTICS_EXPOSURE, bind: existing.BIND_IP })
  const reach = await select<CentralReach>({
    message: 'Who will reach this central',
    choices: reachChoices,
    initial: currentReach ? Math.max(0, reachChoices.findIndex(c => c.value === currentReach)) : 0,
  })
  const reachSettings = settingsForReach(reach)
  if (reach === 'internet') {
    process.stdout.write(
      '\n  Publishing it. This sets AGENTISTICS_EXPOSURE=public (the host-power routes stop\n' +
      '  existing — there is no opt-in), AGENTISTICS_TEAM_TLS=1 and AGENTISTICS_TRUST_PROXY=1.\n' +
      '  The bind stays on 127.0.0.1 ON PURPOSE: the tunnel or proxy in front must be the only\n' +
      '  way in, or everything it enforces can be walked around by addressing this host directly.\n' +
      '  Run `agentop doctor --exposed` before the first outside request — docs/exposure.md.\n',
    )
  }

  // The bind is still the user's to set — a tunnel on ANOTHER machine is a real deployment — but
  // its default now follows the answer above instead of being a question they must keep consistent
  // with it by hand.
  const bind = await input('Bind IP (BIND_IP)', { default: existing.BIND_IP || reachSettings.bind })
  const warning = bindWarning(reach, bind)
  if (warning) process.stdout.write(`\n  WARNING: ${warning}\n`)

  // Database: bundled Docker Mongo, or an external URI (Atlas/remote).
  const db = await select<'bundled' | 'external'>({
    message: 'Database',
    choices: [
      { name: 'Bundled Mongo (Docker starts it for you)', value: 'bundled' },
      { name: 'External URI — Atlas, or a Mongo you run yourself', value: 'external' },
    ],
  })
  let mongoUrl: string | undefined
  if (db === 'external') {
    for (;;) {
      const uri = await input('Mongo connection URI (mongodb+srv://…)', { default: existing.MONGO_URL || '' })
      if (looksLikeMongoUri(uri)) { mongoUrl = uri.trim(); break }
      process.stdout.write('  Invalid URI — must start with mongodb:// or mongodb+srv://\n')
    }
  }

  // Asked AFTER the database, because the database is what decides whether `native` is even on
  // the list: the bundled Mongo is a Docker service, so a native central would have nothing to
  // connect to. Asking first would offer a choice and then withdraw it.
  const facts: CentralRuntimeFacts = {
    script: Boolean(findCentralScript()),
    docker: await hasDocker(),
    envFile: true,
    mongoUrl: mongoUrl ?? BUNDLED_MONGO_URL,
  }
  const runtime = await askRuntime(facts, parseStoredRuntime(existing[RUNTIME_ENV_KEY]) ?? 'docker-image')

  const env = buildCentralEnv({
    port, org, bind, mongoUrl, runtime,
    exposure: reachSettings.exposure,
    tls: reachSettings.tls,
    // Only alongside a loopback bind: the header is believable exactly when the proxy is provably
    // the sole way in, and the user may have widened the bind at the prompt above.
    trustProxy: reachSettings.trustProxy && bindWarning(reach, bind) === null,
  })
  await writeFile(envFile, env, 'utf-8')
  await chmod(envFile, 0o600).catch(() => {})
  process.stdout.write(
    `\nWrote ${envFile} (chmod 600).\n` +
    `  Runs as: ${centralRuntimeLabel(runtime)}\n` +
    `  Change it any time with \`agentop central up --image|--build|--native\`, or re-run this wizard.\n` +
    `  No dashboard password is set here — the first thing you do in the browser is create the\n` +
    `  OWNER account, using the one-time setup token the central prints on its first boot.\n` +
    `  Exposure: ${reachSettings.exposure}${reach === 'internet' ? ' — run `agentop doctor --exposed` before going live' : ''}\n\n`,
  )
}

/** Read a single KEY=value from central.env (no full dotenv parse needed). */
async function readEnvValue(envFile: string, key: string): Promise<string | undefined> {
  try {
    const text = await Bun.file(envFile).text()
    for (const line of text.split('\n')) {
      const m = line.match(new RegExp(`^${key}=(.*)$`))
      if (m) return m[1]
    }
  } catch { /* missing file */ }
  return undefined
}

/** Print the dashboard / central endpoint URL(s) after the central is up. */
async function printAccessUrl(envFile: string): Promise<void> {
  const port = (await readEnvValue(envFile, 'APP_PORT')) || '48080'
  const bind = (await readEnvValue(envFile, 'BIND_IP')) || '0.0.0.0'
  process.stdout.write('\nDashboard / central endpoint:\n')
  if (bind === '0.0.0.0' || bind === '') {
    process.stdout.write(`  local: http://localhost:${port}\n`)
    process.stdout.write('  Members connect to a reachable address of this host (LAN/Tailscale IP) on that port.\n')
  } else {
    process.stdout.write(`  http://${bind}:${port}\n`)
  }
  if (await needsOwnerSetup(port)) {
    const token = await readSetupTokenFromLogs()
    process.stdout.write(
      `\nFirst boot — no owner account exists yet.\n` +
      `  Open the dashboard above: it asks you to CREATE THE OWNER ACCOUNT (name, e-mail, password)\n` +
      `  plus the one-time setup token the central printed to its log.\n` +
      (token
        ? `\n  setup token: ${token}\n`
        // NOT a `docker compose logs` line. That was the suggestion here, and it cannot work:
        // it carried no -f and no --env-file, so from any directory that is not the one holding a
        // compose file, docker has no project to read and prints nothing at all. Reported from a
        // real GHCR install, where the user then had to find `docker logs <container>` themselves.
        //
        // `agentop central setup-token` is the command this very binary implements, so it works
        // wherever this message can be printed — and it MINTS a token rather than hunting for one
        // that has already scrolled past.
        : `\n  Lost it? Reissue with:  agentop central setup-token\n`) +
      `\n  There is no shared team password — everyone else gets their own account, invited by the owner.\n`,
    )
  }
}

/**
 * The one-time setup token the server printed to its log, or null.
 * Best-effort: no Docker, no logs, or a rotated/consumed banner just yields the command hint.
 */
async function readSetupTokenFromLogs(): Promise<string | null> {
  try {
    const proc = Bun.spawn(['docker', 'compose', '-p', PROJECT, 'logs', '--no-color', 'app'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    // The banner prints the token alone on its line; take the LAST one (a re-issued token wins).
    const matches = [...text.matchAll(/^\s*(?:\S+\s+\|)?\s*([0-9a-f]{48})\s*$/gm)]
    return matches.length > 0 ? matches[matches.length - 1]![1]! : null
  } catch {
    return null
  }
}

/**
 * True when the central is up and still has no owner account (first boot).
 * Best-effort and BOUNDED: a central that is slow to answer, or answers something unexpected,
 * simply prints no setup hint — it must never make `up` hang or fail.
 */
async function needsOwnerSetup(port: string): Promise<boolean> {
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${port}/api/iam/status`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (res.ok) {
        const body = (await res.json()) as { needsBootstrap?: unknown }
        return body.needsBootstrap === true
      }
    } catch { /* not listening yet */ }
    if (Date.now() >= deadline) return false
    await new Promise(r => setTimeout(r, 1_000))
  }
}

/** Parse the KEY=value lines of a central.env into a map (ignores comments/blanks). */
async function loadEnvFile(envFile: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  try {
    const text = await Bun.file(envFile).text()
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      out[line.slice(0, eq).trim()] = line.slice(eq + 1)
    }
  } catch { /* missing file → empty */ }
  return out
}

/**
 * Native central lifecycle (external DB → no Docker): the compiled binary IS the server, so we
 * re-invoke `agentop server` with the central env. It runs in the FOREGROUND; for a background
 * service use `agentop autostart central`. Docker-style down/logs/status don't apply here.
 */
async function runNativeCentral(
  envFile: string,
  action: CentralAction,
  extraArgs: string[] = [],
  opts: CentralRunOptions = {},
): Promise<number> {
  const env = await loadEnvFile(envFile)
  const port = env.APP_PORT || '48080'

  // A foreground server cannot be watched from inside the control center: it never exits, so the
  // pane would stream a startup banner and then wait forever. The caller normally knows this in
  // advance (`planCentralStart` answers `native`) and keeps the terminal-handover path; this is the
  // backstop for the case where the env file changed under us between the plan and the run.
  if (opts.streamed && action === 'up') {
    process.stdout.write(
      `\nThis central uses an EXTERNAL database, so it runs NATIVELY in the foreground.\n` +
      `  Start it from a terminal:  agentop central up\n` +
      `  Or as a background service: agentop autostart central\n`,
    )
    return 1
  }

  // A native central has no container to exec into, but this process CAN reach the external DB
  // once it holds central.env — so run the token reissue right here.
  if (action === 'setup-token' || action === 'reset-password') {
    try {
      const proc = Bun.spawn([process.execPath, action, ...extraArgs], {
        env: { ...process.env, ...env, AGENTISTICS_TEAM_CENTRAL: '1' } as Record<string, string>,
        stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
      })
      return await proc.exited
    } catch (err) {
      process.stderr.write(`Could not reissue the setup token: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
  }

  if (action !== 'up') {
    process.stdout.write(
      `\nThis central uses an EXTERNAL database, so it runs NATIVELY (no Docker).\n` +
      `  • start:   agentop central up            (foreground — Ctrl-C to stop)\n` +
      `  • service: agentop autostart central     (run it as a background service)\n`,
    )
    return 0
  }

  if (opts.detached) {
    // The same re-invocation as the foreground path, but detached: `sh -c 'nohup … &'` so the
    // child survives this process exiting, with its output going to a log file instead of a
    // terminal nothing is watching. Mirrors `startBackground()` in cli-start.ts (the native
    // `agentistics` server's own background start) for the same reason: a bare `stdio: 'ignore'`
    // child is still killed when its parent's process group is signalled, and `nohup … &` inside
    // a shell is what actually detaches it.
    const log = join(homedir(), '.agentistics', 'agentop-central.log')
    try {
      await mkdir(dirname(log), { recursive: true })
    } catch { /* best-effort — the spawn below still reports a failure if this truly matters */ }
    try {
      const child = Bun.spawn(
        ['sh', '-c', `nohup ${JSON.stringify(process.execPath)} server >> ${JSON.stringify(log)} 2>&1 &`],
        {
          env: { ...process.env, ...env, PORT: port, AGENTISTICS_TEAM_CENTRAL: '1', SERVE_STATIC: '1' } as Record<string, string>,
          stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
        },
      )
      await child.exited
    } catch (err) {
      process.stderr.write(`Could not start native central: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    process.stdout.write(`\nNative central (external DB) starting in the background on port ${port}.\n`)
    await printAccessUrl(envFile)
    process.stdout.write(`  logs: ${log}\n`)
    return 0
  }

  process.stdout.write(`\nStarting NATIVE central (external DB) on port ${port} …\n`)
  await printAccessUrl(envFile)
  process.stdout.write('  (running in the foreground — Ctrl-C to stop)\n\n')
  try {
    // Re-invoke this same binary as `agentop server`, but in central mode on APP_PORT. The child
    // reads MONGO_URL / password / secret / org from the central.env we pass through.
    const proc = Bun.spawn([process.execPath, 'server'], {
      env: { ...process.env, ...env, PORT: port, AGENTISTICS_TEAM_CENTRAL: '1', SERVE_STATIC: '1' } as Record<string, string>,
      stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
    })
    return await proc.exited
  } catch (err) {
    process.stderr.write(`Could not start native central: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

/**
 * The compose files a published-image central runs with.
 *
 * In a CHECKOUT they are the repository's own `docker/central*.yml` — the very files a reader can
 * review — so `--image` inside a clone is `--build` minus the build, with the same overlays and
 * the same project name. Outside one they are materialized under ~/.agentistics/central from the
 * constants above.
 *
 * The bundled-Mongo overlay is included on exactly the rule `central.sh` applies: only when
 * MONGO_URL targets the internal service. An external cluster gets no local Mongo container and
 * nothing waiting on one.
 */
async function imageComposeFiles(
  script: string | null,
  facts: { bundled: boolean; selfContrib: boolean },
): Promise<string[] | null> {
  if (script) {
    const dir = join(dirname(script), 'docker')
    const files = [join(dir, 'central.image.yml')]
    if (facts.bundled) files.push(join(dir, 'central.localdb.yml'))
    if (facts.selfContrib) files.push(join(dir, 'central.selfcontrib.yml'))
    const missing = files.filter(f => !existsSync(f))
    if (missing.length > 0) {
      process.stderr.write(
        `This checkout is missing ${missing.join(', ')}.\n` +
        'Update it (git pull), or run without --image to build from source.\n',
      )
      return null
    }
    return files
  }

  const app = join(STANDALONE_DIR, 'central.image.yml')
  const files = [app]
  try {
    await writeFile(app, STANDALONE_COMPOSE, 'utf-8')
    if (facts.bundled) {
      const db = join(STANDALONE_DIR, 'central.localdb.yml')
      await writeFile(db, STANDALONE_LOCALDB_COMPOSE, 'utf-8')
      files.push(db)
    }
  } catch (err) {
    process.stderr.write(`Could not write the compose files in ${STANDALONE_DIR}: ${err instanceof Error ? err.message : String(err)}\n`)
    return null
  }
  return files
}

/**
 * Central lifecycle for the two runtimes `central.sh` does not own: the published image, and the
 * native server.
 *
 * The runtime is DECIDED by `runCentral` and passed in, rather than re-derived from MONGO_URL
 * here. It used to be inferred at this point, which is why `--image` and `--native` had nowhere to
 * enter: the function's only input was what the database happened to be.
 */
async function runCentralStandalone(
  action: CentralAction,
  extraArgs: string[] = [],
  opts: CentralRunOptions = {},
  runtime: 'docker-image' | 'native' = 'docker-image',
  how?: CentralStartHow,
): Promise<number> {
  const script = findCentralScript()
  const envFile = centralEnvFile(script)

  // Streamed means the control center is drawing and Ink owns the keyboard, so there is no terminal
  // to ask a question with — the same thing `[ -t 0 ]` tells central.sh on the repo path.
  const isTTY = process.stdin.isTTY && opts.streamed !== true

  try {
    await mkdir(dirname(envFile), { recursive: true })
  } catch (err) {
    process.stderr.write(`Could not prepare ${dirname(envFile)}: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  if (action === 'init') {
    if (!isTTY) { process.stderr.write('init needs an interactive terminal.\n'); return 1 }
    await initEnv(envFile)
    return 0
  }

  // On `up`, ensure central.env exists (prompt if TTY) BEFORE deciding Docker vs native.
  // `-y` / `-n` answer that question up front — the same words central.sh takes on the repo path,
  // so `agentop central up -n` is unattended wherever it lands. (The cache flags mean nothing
  // here: this path PULLS the published image, it never builds one.)
  if (action === 'up') {
    const parsed = parseRebuildFlags(extraArgs)
    const answer = parsed.ok ? parsed.flags.setup : undefined
    if (!existsSync(envFile)) {
      if (answer === 'no') {
        process.stderr.write(`${envFile} not found, and -n says not to create it. Run \`agentop central init\` first.\n`)
        return 1
      }
      if (!isTTY) { process.stderr.write(`${envFile} not found and stdin is not a TTY — run \`agentop central init\` first.\n`); return 1 }
      process.stdout.write(`${envFile} not found — let's create it.\n`)
      await initEnv(envFile)
    } else if (answer === 'yes') {
      await initEnv(envFile)
    } else if (!answer && isTTY) {
      const rerun = await confirm(`${envFile} exists. Re-run interactive setup?`, false)
      if (rerun) await initEnv(envFile)
    }
  } else if (!existsSync(envFile)) {
    process.stderr.write(`No central configured yet at ${envFile}. Run \`agentop central up\` first.\n`)
    return 1
  }

  const mongoUrl = (await readEnvValue(envFile, 'MONGO_URL')) ?? ''

  if (runtime === 'native') {
    // `--bg` is what makes the already-implemented detached start reachable from the command line.
    // It existed only as an internal option the control center could set, so the CLI's native
    // central was foreground-or-nothing and every "run it in the background" answer was a
    // systemd unit.
    return runNativeCentral(envFile, action, extraArgs, {
      ...opts,
      detached: how === 'bg' ? true : opts.detached,
    })
  }

  const composeFiles = await imageComposeFiles(script, {
    bundled: isBundledMongo(mongoUrl) || mongoUrl === '',
    selfContrib: Boolean((await readEnvValue(envFile, 'AGENTISTICS_CENTRAL_USER')) ?? ''),
  })
  if (!composeFiles) return 1

  if (action === 'up') {
    process.stdout.write(`\nStarting central from image ${IMAGE} …\n\n`)
    const code = await runCompose(envFile, composeFiles, ['up', '-d', '--pull', 'always', '--force-recreate'], opts)
    if (code === 0) {
      await runCompose(envFile, composeFiles, ['ps'], opts)
      await printAccessUrl(envFile)
    }
    return code
  }

  switch (action) {
    case 'restart': {
      const code = await runCompose(envFile, composeFiles, ['restart', 'app'], opts)
      if (code === 0) await printAccessUrl(envFile)
      return code
    }
    case 'logs':
      return runCompose(envFile, composeFiles, ['logs', '-f', 'app'], opts)
    case 'status':
      return runCompose(envFile, composeFiles, ['ps'], opts)
    case 'down':
      // No `-v` — the Mongo data volume is preserved.
      return runCompose(envFile, composeFiles, ['down'], opts)
    case 'setup-token':
      // Inside the container: that is where MONGO_URL resolves.
      return runCompose(envFile, composeFiles, ['exec', '-T', 'app', 'bun', 'run', 'packages/server/bin/cli.ts', 'setup-token'], opts)
    case 'reset-password':
      return runCompose(
        envFile, composeFiles,
        ['exec', '-T', 'app', 'bun', 'run', 'packages/server/bin/cli.ts', 'reset-password', ...extraArgs],
        opts,
      )
    case 'pull': {
      const code = await runCompose(envFile, composeFiles, ['pull'], opts)
      if (code === 0) return runCompose(envFile, composeFiles, ['up', '-d', '--force-recreate'], opts)
      return code
    }
  }
  return 0
}
