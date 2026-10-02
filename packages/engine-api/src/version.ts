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
export const ENGINE_API_VERSION = '1.5.0'

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
