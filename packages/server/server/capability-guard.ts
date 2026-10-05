/**
 * capability-guard.ts — maps a request path to the local capability it needs, and turns a
 * revoked capability into a 403.
 *
 * Kept separate from index.ts so the mapping is unit-testable and so a newly added local-power
 * route is a one-line registration instead of a scattered `if`.
 *
 * SECURITY: these routes execute shell commands, spawn coding-assistant CLIs, read the host's
 * raw conversation transcripts, or rewrite ~/.claude.json. They must be unreachable on an
 * internet-exposed instance regardless of who is authenticated — a `member` account is not a
 * reason to hand out a shell. A route that is NOT registered here is assumed harmless, so a
 * missed registration is a vulnerability, not an oversight.
 */
import { CAPS, type Capabilities } from './exposure'

/** Exact path → capability. Detail sub-paths are handled by the prefix table below. */
const EXACT: ReadonlyMap<string, keyof Capabilities> = new Map<string, keyof Capabilities>([
  ['/api/exec', 'localShell'],
  // It DOWNLOADS a release binary, EXECUTES it and restarts the service serving this page — the
  // most powerful thing this product does from a browser, so it rides the gate the shell rides.
  // `upgrade-gate.ts` refuses a central on top of this, and says so in words.
  ['/api/upgrade', 'localShell'],
  // It SPAWNS `tailscale` to read what this machine is already serving — a process, so it is host
  // power and belongs here. It configures nothing; see `secure-origin.ts`.
  ['/api/secure-origin', 'localShell'],
  // It STARTS the configured MCP command to see whether it answers. Host power, and the reason the
  // route looks the server up in the CONFIG rather than taking a command from the body.
  ['/api/mcp/check', 'localShell'],
  // Same reason as `/api/mcp/check`, one line up: it starts every configured server's command to
  // ask `tools/list`, so it rides `localShell` rather than the `mcpAdmin` prefix below — reading
  // and writing the CONFIGURATION is a different power from RUNNING it.
  ['/api/mcp/tools', 'localShell'],
  ['/api/chat-tty', 'localChat'],
  ['/api/chat-harnesses', 'localChat'],
  ['/api/projects-list', 'localTranscripts'],
  // Returns this machine's decrypted sibling messages — a peer's FULL source list, plus its own
  // key fingerprints. Strictly more sensitive than /api/team/status, which deliberately exposes
  // only counts, so it is host-local data and must be unreachable on an exposed instance.
  ['/api/team/proposals', 'localTranscripts'],
  // Reads ~/.claude.json, ~/.claude/settings*.json and ~/.claude/.credentials.json to propose how
  // this machine is billed. It extracts only non-secret fields, but the ANSWER is still host
  // configuration and the files are the most sensitive this product touches, so it rides the same
  // capability as the transcript routes rather than getting one of its own: there is no
  // deployment that should read a transcript but not this.
  ['/api/billing/detect', 'localTranscripts'],
  ['/api/hardware-resources', 'localProcesses'],
  // The session fleet is registered as a PREFIX below, not name by name — see the note there.
])

/** Prefix (no trailing slash) → capability. Matches `<prefix>` and `<prefix>/…` only. */
const PREFIXES: ReadonlyArray<readonly [string, keyof Capabilities]> = [
  // RES.1 — the process governor: reads every agentop process on the host, kills on request, and
  // registers helper processes. Host power, so the strictest capability.
  ['/api/resources', 'localShell'],
  ['/api/claude-sessions', 'localTranscripts'],
  ['/api/codex-sessions', 'localTranscripts'],
  ['/api/gemini-sessions', 'localTranscripts'],
  ['/api/copilot-sessions', 'localTranscripts'],
  ['/api/nay-sessions', 'localTranscripts'],
  // The session fleet, and everything under it. `/api/fleet` alone captures each live session's
  // SCREEN — a coding assistant's terminal, transcript and all — `/api/fleet/act` types into it,
  // answers a permission prompt for it or kills it, `/api/fleet/stream` streams that screen
  // continuously, `/api/fleet/attach` hands out the command that enters it, and `/api/fleet/new`
  // starts a fresh assistant in a directory the caller names. That is shell access with extra
  // steps, so it rides `localShell` rather than the softer `localChat`: there is no deployment that
  // should expose someone's keyboard to the internet and a shell is the honest name for it.
  //
  // A PREFIX and not five names: a route that is not registered here is assumed harmless, so the
  // next fleet route someone adds must be guarded by having been added AT ALL, never by having
  // remembered a second table.
  ['/api/fleet', 'localShell'],
  // The per-session UTILITY SHELL. It spawns `$SHELL` on the host in a directory of the caller's
  // session and types whatever arrives into it — the most powerful thing this server offers, more
  // than `/api/fleet` itself, which at least only ever runs a NAMED assistant CLI. Same capability,
  // and a PREFIX for the same reason: the next shell route must be guarded by having been added at
  // all. The user's own opt-in switch is enforced separately, in index.ts — see shell-gate.ts.
  ['/api/shell', 'localShell'],
  // The task board reads the session registry and the local store, and its DELIVER verb runs git in
  // the directories those sessions ran in. That is host power, so it rides the same capability as
  // the fleet — and a prefix for the same reason: the next task route must be guarded by having
  // been added at all, never by having remembered a second table.
  ['/api/tasks', 'localShell'],
  // User session groups: the routes behind the MCP tools that file a session under a group. They
  // resolve a session reference against THIS machine's fleet, so they read host state the same way
  // `/api/fleet` does, and they are refused on a central for the same reason.
  ['/api/session-groups', 'localShell'],
  // Per-session notification switch: resolves a ref against THIS machine's fleet, same as above.
  ['/api/session-notify', 'localShell'],
  // The file store is addressed by file id rather than under `/api/tasks/`, so it needs its own
  // entry: a route that is not registered here is assumed harmless.
  ['/api/task-files', 'localShell'],
  // The native runtime's provider settings (`provider-web.ts`, UI.1): the list, PUT/DELETE of one
  // provider's base URL and key, and its `/test` and `/models` sub-resources. Registered as a PREFIX
  // ahead of the routes, so each one is guarded by having been ADDED, never by having remembered a
  // second table. They touch a host secret (the stored API key, credentials.ts) and reach out to a
  // provider on this machine's account — exactly the class of route this table exists to catch.
  ['/api/provider', 'localShell'],
  // The web dashboard's read of the backup engine and its "run now" button. `status` walks the
  // metrics layer and the backup history; `run` spawns `git bundle`/`git diff` across every known
  // repository and, depending on the configured layers, copies the raw harness directories
  // (`~/.claude`, `~/.codex`, …) into an archive on disk — the same shell-and-filesystem power
  // `/api/exec` carries, so it rides the same capability rather than a softer one.
  ['/api/backup', 'localShell'],
  // Settings → Vault: which secrets are sealed on this machine (metadata only, never a value) and the
  // "lock now" action. It is about THIS host's key material, so it rides the host-power gate and is
  // refused on a central by `index.ts` as well.
  ['/api/vault', 'localShell'],
  // The running server's experimental-feature state (GET) and its switch (PUT, via the `agentop experimental` command).
  // It reports and changes which host features this machine runs, so it rides the same capability.
  ['/api/experimental', 'localShell'],
  // Reading and WRITING this machine's MCP server configuration. `/api/mcp/servers` reports what is
  // configured and what is running; `/api/mcp/install` and `/api/mcp/remove` run `claude mcp` to
  // change it. A PREFIX for the same reason `/api/fleet` is one: the next route here is guarded by
  // having been added at all, never by having remembered a second table.
  // It replaced `/api/mcp-list` + `/api/mcp-action`, which had no client and read two files that
  // hold no MCP servers at all (`~/.claude/settings.json` and `<project>/.claude/settings.json`) —
  // a second lister giving a different, wrong answer is the drift this codebase is built against.
  ['/api/mcp', 'mcpAdmin'],
  // The projection query (`runtime-metrics-web.ts`, P3 §3). It reads THIS machine's projection store,
  // which is derived from the host's own transcripts: per-session models, repositories, project PATHS,
  // task ids and tool usage. That is host transcript data one fold removed, so it rides
  // `localTranscripts` — the gate the transcript readers ride — and is unreachable on an exposed
  // profile. A PREFIX so a sub-route added later is guarded by having been added at all; scoped to
  // `/api/runtime/metrics` rather than all of `/api/runtime`, whose other routes (§28) spawn and
  // drive sessions and need their own, stronger decision.
  ['/api/runtime/metrics', 'localTranscripts'],
  // The dev config file (`env-config.ts`): `PUT /api/config` rewrites `.env.config` beside the
  // server and `POST /api/config/restore` copies its backup over it. `loadEnvConfig` feeds that
  // file into `process.env` at the next start, so this is a write to the file that decides how the
  // host's own server boots — and a value is written verbatim, newline included, so it is not
  // limited to the two keys the form shows. That is host power over this product's own security
  // posture, the class of route `localShell` exists for; `mcpAdmin` is scoped to MCP configuration
  // and would be the softer, wrong name. A PREFIX so `/api/config/restore` and any later sub-route
  // are guarded by having been added at all. The GET rides it too: the dev panel is a local tool.
  ['/api/config', 'localShell'],
  // THE ENGINE'S RESERVED PREFIXES (`@agentistics/engine-api`'s `RESERVED_PREFIXES`). They are held
  // HERE, in the public table, whether or not an engine is loaded: a guard that shipped with the
  // engine could not be tested by a build without one. An engine route must declare exactly the
  // capability this table holds for its prefix or the host refuses it at load (`engine/load.ts`),
  // so an engine can never weaken the guard on its own door. `capability-guard.test.ts` asserts
  // every reserved prefix resolves.
  //  - `/api/runtime/sessions` spawns and drives native sessions: host power, `localShell`.
  //  - `/api/ingest` and the OTLP routes (logs, metrics, traces) receive a harness's live record of this machine's
  //    conversations — transcript data by another road, so the transcript readers' gate.
  ['/api/runtime/sessions', 'localShell'],
  // B6.6: the native runtime's memory — facts derived from this person's sessions; forgetting writes
  // the journal. Host state, the native sessions' own capability.
  ['/api/memory', 'localShell'],
  ['/api/ingest', 'localTranscripts'],
  ['/v1/logs', 'localTranscripts'],
  ['/v1/metrics', 'localTranscripts'],
  ['/v1/traces', 'localTranscripts'],
]

/** One registration, as `registeredRoutes()` reports it. */
export interface RegisteredRoute {
  readonly path: string
  readonly match: 'exact' | 'prefix'
  readonly capability: keyof Capabilities
}

/**
 * Every registration in both tables, read-only, in declaration order.
 *
 * Exists so a test can WALK the table instead of restating it: `host-allow.test.ts` asserts that
 * every `localShell` route — and a sub-path under every prefix, including one nobody has written
 * yet — is refused under a rebinding Host. A route added here is covered by that test by having
 * been added, which is the same property the prefix table gives the capability check itself.
 * A copy, so a caller cannot mutate the tables the guard reads.
 */
export function registeredRoutes(): readonly RegisteredRoute[] {
  const out: RegisteredRoute[] = []
  for (const [path, capability] of EXACT) out.push(Object.freeze({ path, match: 'exact' as const, capability }))
  for (const [path, capability] of PREFIXES) out.push(Object.freeze({ path, match: 'prefix' as const, capability }))
  return Object.freeze(out)
}

export function routeCapability(pathname: string): keyof Capabilities | null {
  const exact = EXACT.get(pathname)
  if (exact) return exact
  for (const [prefix, cap] of PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return cap
  }
  return null
}

/**
 * A ready 403 when the capability is off, or null when the call may proceed.
 * The caller spreads CORS_HEADERS over the response.
 */
export function capabilityDenied(
  cap: keyof Capabilities,
  caps: Capabilities = CAPS,
): Response | null {
  if (caps[cap]) return null
  return new Response(JSON.stringify({ error: 'capability_disabled', capability: cap }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  })
}
