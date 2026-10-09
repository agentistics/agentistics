/**
 * version.ts — the semver of THIS contract, not of either product.
 *
 * A major bump is a breaking change to a type or a function here. Growing `ReuseSurface`, adding an
 * optional member or a new reserved prefix is a minor bump.
 */

/**
 * 1.1.0 — an integration may declare its `entityIds` (the derivations the journal's store import
 * shares with its replay), and a route's `handle` receives the request's `EngineRequestContext`.
 * Both optional, so an engine built against 1.0 still loads.
 */
/**
 * 1.2.0 — `ReuseSurface` carries the 48 public functions an engine reuses (it was empty), the host
 * names its origin policy (`originPolicy()`) and OpenCode's database file (`paths.opencodeDbPath`),
 * and `EngineAuditEvent.action` is the host's `AuditAction` union instead of `string`. An engine
 * built against 1.1 still loads: it reads none of the new members.
 */
/**
 * 1.3.0 — the policy floor arrives as GLOBS (`protectedGlobs`, derived by the pure `protectedGlobs()`
 * in `floor.ts`), because an absolute path cannot express a backup-plan `contains` row (`.key`); and
 * `EngineSpawnBudget` carries the swap `alarm` and an explicit `unmeasured` flag. An engine built
 * against 1.2 still loads: `protectedPaths` is kept, and now also carries the globs in absolute form.
 */
/**
 * 1.4.0 — LIVE.3: the host's CONFIRMED fleet transitions (`EngineHostServices.fleet`, the event
 * channel's two-consecutive-polls rule already applied), the contract version the host speaks
 * (`apiVersion`, so an engine can tell a 1.4 host from an older one before asking it a 1.4 question),
 * and the `live` flag (`AGENTISTICS_JOURNAL` + `AGENTISTICS_JOURNAL_LIVE`). All optional, so an
 * engine built against 1.3 still loads and an engine built against 1.4 still runs on a host that
 * offers none of them.
 */
/**
 * 1.5.0 — the machine's vault: `EngineHostServices.secrets` (optional), through which an engine
 * seals and opens ITS OWN secrets (purposes `engine/…`) without ever holding the data key. Optional,
 * so a 1.5 engine still loads on an older host — and refuses to STORE a provider key there rather
 * than write it in plain text. `EngineAuditAction` gains `vault.migrated`, `vault.plaintext-pending`
 * and `vault.migration-failed`, so the engine reports its own migration (S1, provider keys — the
 * engine is that file's ONLY owner; the host never touches `provider-keys/`) through `host.audit`,
 * which writes them to the machine's `vault/audit.jsonl`.
 */
/**
 * 1.6.0 — SECRETS.4: `EngineSecrets.status()` may carry `lockedBy` and `autoLockInMs`, and
 * `EngineSecrets.onStateChange` (all optional) lets an engine wait for an unlock instead of polling.
 * `VaultRefusal` is NOT widened (a wider returned union breaks an exhaustive switch — a major): the
 * new causes arrive as `code: 'locked'` with the sentence and `lockedBy`. An engine built against 1.5
 * still loads; a 1.6 engine on a 1.5 host sees `undefined` for each new member and must cope.
 */
/**
 * 1.7.0 — B6.5: `tasks.board` (optional), the task board's own operations in process — list, get,
 * next, activity, create, subtask, comment, status, claim and attach — so a native session's board
 * tools reach the board without an HTTP loopback or a second auth path. An engine built against 1.6
 * still loads; a 1.7 engine on an older host finds `board` absent and offers no board tools.
 * Also (B6.2): `fleet.delegateHarnesses / delegateSpawn / lastReply / stop` (optional) — an engine's
 * agent may run as a session of another harness, started by the HOST, which alone decides whether the
 * person allowed that harness (default deny) and files the session on the board.
 * Also (A5.2): \`/v1/traces\` joins \`RESERVED_PREFIXES\` (guarded \`localTranscripts\` like the other OTLP
 * routes). An engine registers it only on a host that speaks 1.7 — an older host refuses an
 * unreserved prefix at load.
 * Also (A5.4): `Engine.acp` (optional) drives an ACP-speaking harness for the host's fleet, and the host
 * offers `serverPort()` (optional) for an engine to write into a harness's exporter config.
 * Also (UI.2/UI.3): native sessions filed on the board carry their cost: `NativeSessionLink` gains `label`,
 * `cwd` and `usage` (`NativeSessionUsage`, the engine's own snapshot), and `tasks.reportNativeUsage`
 * refreshes that snapshot for a session already filed. All optional, so a 1.6 engine still loads and
 * a 1.7 engine on an older host files with no cost (the board then says "not measured").
 * Also (INV.1): `invocationCache` (optional) — the host's held answers by deterministic invocation id,
 * asked before a resumed run re-sends a model call; a hit is journaled `model.completed {replayed}`.
 * Absent on every host today, and then every call is simply made.
 * Also (H17): `events.nativeSession` (optional) — a native session's own state change (asked the
 * person / a run ended / a run started) into the host's event channel and its desktop delivery.
 * 1.8.0 — ES.6h: the `code` tab's contract. `CodeHost` (opaque until now) gains OPTIONAL typed members (`CodeHostPort`:
 * availability, defaults, tasks, start/resume, an event subscription, submit/answer/cancel/end; `code-host.ts`) and
 * `asCodePort()` reads them. An engine built against 1.7 still loads (its handle is simply not a port: the tab says
 * so); a 1.8 engine on an older host is offered no `code` tab. The port's later members are optional too (the
 * TUI's P3–P5 screens): `cycleMode` (CD-15), `recentSessions` (HM-04/SS-01), `rename` (SS-08), `promptHistory`
 * (CD-18), `answer`'s `reason` (CD-08), the `mode`/`rules` events and the tool/usage timing fields — a 1.8
 * engine without them still satisfies the port and the tab degrades (says so, or shows nothing extra).
 * Also (VAULT.PERSONAL §8.3): `EngineHostServices.vaultRefs` (optional) — a native session's env overlay
 * for the personal secrets its person granted it, and a scrubber for every tool output. Optional, so a
 * 1.8 engine loads on an older host (it offers no references there) and an older engine never reads it.
 * Also (the native harness queue, B6/ART/H24): `journal.readRare` (ART.2, the artifact store's index),
 * `memory` (B6.6), `serverOrigins` (B6.4, the browser never drives the host's own API), `environment`
 * (B8.8, the names a declaration references), the route `transport` / `localSocket` (B4.6), the `reasoning` part of a stored assistant message
 * (B9.1) and `NativeSessionUsage.byModel` (H24). All optional: a 1.7 engine never reads them, and a
 * 1.8 engine on an older host runs without memory, artifacts index or vault references.
 */
/**
 * 1.9.0 — ENGINE.MAP F1.1: the chat channel (`chat.ts`). `HarnessIntegration.chat` (or `chatAbsent`,
 * the one sentence why not) serves a conversation's turns, in-flight text and state from ONE
 * incremental cursor per source, never journaled: `resolve(ref) → ChatSourceRef | null` and
 * `follow(src, max, on) → unsubscribe` with `HarnessChatDelta`s `window | append | grow | live | state |
 * fork`, each harness DECLARING which of state / attention / live / fork it can say (`ChatDeclaration`).
 * `EngineChatTurn` mirrors core's `ChatTurn`, which moved to `@agentistics/core` so host and engine share
 * it; `applyHarnessChatDeltas` is the one definition of how a receiver applies the deltas;
 * `manifest.provides.chat` lists who serves one. All optional: a 1.8 engine still loads (it serves no
 * chat and the host keeps its own readers), and a 1.9 engine on a 1.8 host is simply never asked.
 */
/**
 * 1.10.0 — ENGINE.MAP F2.0: STRUCTURED sessions (`structured.ts`). `Engine.structured` (optional) is ONE
 * backend for every harness with an official machine protocol, driven by a per-harness DRIVER (`acp`,
 * `claude-stream-json`, `codex-app-server`, `agy-stream-json`; a driver not written yet is a `stub` that
 * refuses every start in a sentence). A driver DECLARES per harness what it carries (assigned id, resume,
 * model, effort, MCP, the opening context `instructions` channel, live text, permissions, questions,
 * cancel); a session states its activity and the open request, answers by option number / free text,
 * and follows on the chat seam (`HarnessChatDelta`). `structuredRegistry` / `stubDriver` / `answerFits`
 * are the pure helpers. All optional: a 1.9 engine still loads (the host keeps `Engine.acp` and tmux),
 * and a 1.10 engine on a 1.9 host is simply never asked.
 */
export const ENGINE_API_VERSION = '1.10.0'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function parse(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * PURE. May a host built against `host` load an engine built against `engine`?
 *
 * Same major, and the engine's minor no newer than the host's: an engine built against 1.3 may use
 * something a 1.2 host does not provide. A version that does not parse is REFUSED — a load that
 * cannot be shown compatible is not one.
 */
export function apiCompatible(host: string, engine: string): boolean {
  const h = parse(host)
  const e = parse(engine)
  if (!h || !e) return false
  return h[0] === e[0] && e[1] <= h[1]
}
