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
 */
export const ENGINE_API_VERSION = '1.7.0'

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
