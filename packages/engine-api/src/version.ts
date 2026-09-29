/**
 * version.ts — the semver of THIS contract, not of either product.
 *
 * A major bump is a breaking change to a type or a function here. Growing `ReuseSurface`, adding an
 * optional member or a new reserved prefix is a minor bump.
 */

export const ENGINE_API_VERSION = '1.0.0'

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
