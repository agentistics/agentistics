/**
 * projections/state-codec.ts — PURE. A projection's fold STATE, to text and back.
 *
 * The materialised store (`store.ts`) persists each key's fold state so the next catch-up pass folds
 * new events ONTO it instead of re-reading the journal from rowid 0 — the same move
 * `transcript-state.ts` makes for a live transcript. The states are plain objects holding `Map`s and
 * `Set`s (`SessionMetaState` is the model), which `JSON.stringify` silently turns into `{}`; so this
 * codec tags them, and `decodeState(encodeState(s))` must fold and finish exactly like `s` — which
 * `state-codec.test.ts` pins over a real session's state, and `materialized.test.ts` pins again at the
 * store level (a walk resumed from the database equals one folded whole).
 *
 * Rules:
 * - A `Map` becomes `{"$m": [[k, v], …]}` and a `Set` `{"$s": [v, …]}`, recursively. An ordinary object
 *   that happens to carry a `$m`/`$s` key is escaped as `{"$o": {…}}`, so no real value can be read back
 *   as a collection it never was.
 * - `undefined` properties are dropped (as JSON drops them); every state in this directory reads an
 *   absent key and an `undefined` one identically, and a test checks the round trip.
 * - A non-finite number has no JSON form and would come back as `null` — a silent change of meaning.
 *   `encodeState` THROWS instead, so the store refuses to persist a state it could not restore.
 */

const TAG_MAP = '$m'
const TAG_SET = '$s'
const TAG_OBJ = '$o'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function toJsonable(v: unknown): unknown {
  if (v === null) return null
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v
    case 'number':
      if (!Number.isFinite(v)) throw new RangeError(`state-codec: a non-finite number (${v}) cannot be persisted`)
      return v
    case 'undefined':
      return undefined
    case 'object':
      break
    default:
      throw new TypeError(`state-codec: cannot persist a ${typeof v}`)
  }
  if (Array.isArray(v)) return v.map(x => {
    const j = toJsonable(x)
    return j === undefined ? null : j
  })
  if (v instanceof Map) return { [TAG_MAP]: [...v].map(([k, x]) => [toJsonable(k), toJsonable(x) ?? null]) }
  if (v instanceof Set) return { [TAG_SET]: [...v].map(x => toJsonable(x) ?? null) }
  if (!isPlainObject(v)) throw new TypeError('state-codec: only plain objects, arrays, Maps and Sets can be persisted')
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) {
    const j = toJsonable(x)
    if (j !== undefined) out[k] = j
  }
  if (TAG_MAP in out || TAG_SET in out || TAG_OBJ in out) return { [TAG_OBJ]: out }
  return out
}

function fromJsonable(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(fromJsonable)
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length === 1) {
    if (keys[0] === TAG_MAP && Array.isArray(o[TAG_MAP])) {
      return new Map((o[TAG_MAP] as [unknown, unknown][]).map(([k, x]) => [fromJsonable(k), fromJsonable(x)]))
    }
    if (keys[0] === TAG_SET && Array.isArray(o[TAG_SET])) return new Set((o[TAG_SET] as unknown[]).map(fromJsonable))
    if (keys[0] === TAG_OBJ && o[TAG_OBJ] !== null && typeof o[TAG_OBJ] === 'object') {
      const inner = o[TAG_OBJ] as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(inner)) out[k] = fromJsonable(x)
      return out
    }
  }
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(o)) out[k] = fromJsonable(x)
  return out
}

/** A state to text. Throws on a value that could not be restored faithfully (see the header). */
export function encodeState(state: unknown): string {
  return JSON.stringify(toJsonable(state))
}

/** Text back to a state. The caller asserts its type — the store keys every row by its projection. */
export function decodeState<S>(text: string): S {
  return fromJsonable(JSON.parse(text)) as S
}

/**
 * JSON with every object's keys SORTED — how an output row is stored. A finished result can carry an
 * object whose key order is its fold's insertion order (`session-meta.ts`'s `tool_counts` is built
 * from a `Map`), which is arrival order: equal answers would be stored as different text, and a store
 * built from a shuffled journal would not be byte-identical to one built in order. Arrays keep their
 * order — every projection here already sorts the arrays it returns.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) out[k] = o[k]
    return out
  })
}
