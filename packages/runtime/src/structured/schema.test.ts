/**
 * schema.test.ts — the structured-result subset: what is refused (in words), what can never be
 * satisfied, and — the property half — that `validate` accepts exactly what a second, deliberately
 * naive validator over the same subset accepts, across generated schemas and values.
 *
 * The generator is seeded (mulberry32), so a failure prints a seed that reproduces it.
 */
import { describe, expect, test } from 'bun:test'
import { compileSchema, formatValidationErrors, MAX_REPORTED_ERRORS, validate, type Schema } from './schema.ts'

// ── Refusal: every keyword outside the subset, named ────────────────────────────────────────────

describe('compileSchema — the subset', () => {
  const OUTSIDE = [
    'oneOf', 'anyOf', 'allOf', 'not', '$ref', '$defs', 'definitions', 'pattern', 'format', 'minLength',
    'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'multipleOf', 'minItems', 'maxItems',
    'uniqueItems', 'const', 'default', 'description', 'title', 'examples', 'patternProperties',
    'propertyNames', 'if', 'then', 'else', 'dependentRequired', 'prefixItems', 'contains', '$schema',
  ]
  for (const kw of OUTSIDE) {
    test(`refuses "${kw}" with a sentence naming it`, () => {
      const r = compileSchema({ type: 'string', [kw]: 1 })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.unsatisfiable).toBe(false)
      expect(r.problems.some(p => p.includes(`"${kw}"`) && p.includes('not supported'))).toBe(true)
    })
  }

  test('a keyword nested deep is refused with its path', () => {
    const r = compileSchema({
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'object', properties: { n: { type: 'number', minimum: 0 } } } } },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems.join(' ')).toContain('"minimum" at $.list[].n')
  })

  test('every problem is reported, not only the first', () => {
    const r = compileSchema({ type: 'object', oneOf: [], properties: { a: { type: 'string', pattern: 'x' } } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.problems.some(p => p.includes('"oneOf"'))).toBe(true)
      expect(r.problems.some(p => p.includes('"pattern"'))).toBe(true)
    }
  })

  test('additionalProperties is supported only as false', () => {
    expect(compileSchema({ type: 'object', additionalProperties: false }).ok).toBe(true)
    for (const v of [true, {}, { type: 'string' }]) {
      const r = compileSchema({ type: 'object', additionalProperties: v })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.problems[0]).toContain('"additionalProperties"')
    }
  })

  test('type must be one subset type — no lists, no null', () => {
    for (const t of [['string', 'null'], 'null', 'date', 3]) {
      const r = compileSchema({ type: t })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.problems[0]).toContain('"type"')
    }
  })

  test('a node stating neither type nor enum is refused (it constrains nothing)', () => {
    const r = compileSchema({ type: 'object', properties: { a: {} } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems[0]).toContain('$.a')
  })

  test('keywords of the wrong type are refused, not ignored', () => {
    expect(compileSchema({ type: 'string', properties: {} }).ok).toBe(false)
    expect(compileSchema({ type: 'string', items: { type: 'string' } }).ok).toBe(false)
    expect(compileSchema({ type: 'object', required: 'a' }).ok).toBe(false)
    expect(compileSchema({ type: 'object', required: ['a', 'a'] }).ok).toBe(false)
    expect(compileSchema({ enum: 'a' }).ok).toBe(false)
    expect(compileSchema('string').ok).toBe(false)
  })

  test('a schema inside the subset compiles', () => {
    const r = compileSchema({
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        score: { type: 'integer' },
        notes: { type: 'array', items: { type: 'string' } },
        ok: { type: 'boolean' },
        ratio: { type: 'number' },
      },
      required: ['verdict', 'score'],
      additionalProperties: false,
    })
    expect(r.ok).toBe(true)
  })
})

// ── Satisfiability ──────────────────────────────────────────────────────────────────────────────

describe('compileSchema — satisfiability', () => {
  const unsat = (raw: unknown, needle: string) => {
    const r = compileSchema(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.unsatisfiable).toBe(true)
      expect(r.problems.join(' ')).toContain(needle)
    }
  }
  test('an empty enum', () => unsat({ enum: [] }, 'is empty'))
  test('an enum none of whose values has the type', () => unsat({ type: 'integer', enum: [1.5, 'a'] }, 'has the type "integer"'))
  test('a required key outside properties under additionalProperties:false', () =>
    unsat({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'], additionalProperties: false }, '"b" is required'))
  test('a required property whose own schema is unsatisfiable', () =>
    unsat({ type: 'object', properties: { a: { type: 'string', enum: [] } }, required: ['a'] }, '$.a'))
  test('an enum on an object whose members all violate the rest of the node', () =>
    unsat({ type: 'object', required: ['x'], enum: [{ y: 1 }] }, 'satisfies the rest'))

  test('an OPTIONAL unsatisfiable property does not make the parent unsatisfiable', () => {
    expect(compileSchema({ type: 'object', properties: { a: { enum: [] } } }).ok).toBe(true)
  })
  test('unsatisfiable items do not make an array unsatisfiable ([] is valid)', () => {
    expect(compileSchema({ type: 'array', items: { enum: [] } }).ok).toBe(true)
  })
  test('a required key outside properties WITHOUT additionalProperties:false is satisfiable', () => {
    expect(compileSchema({ type: 'object', properties: {}, required: ['b'] }).ok).toBe(true)
  })
})

// ── Validation, by example ──────────────────────────────────────────────────────────────────────

function compiled(raw: unknown): Schema {
  const r = compileSchema(raw)
  if (!r.ok) throw new Error(r.problems.join(' '))
  return r.schema
}

describe('validate — examples', () => {
  const s = compiled({
    type: 'object',
    properties: { a: { type: 'integer' }, b: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } } },
    required: ['a'],
    additionalProperties: false,
  })
  test('valid', () => expect(validate(s, { a: 3, b: ['x', 'y'] })).toEqual([]))
  test('paths name locations, messages never quote the value', () => {
    const errs = validate(s, { a: 1.5, b: ['x', 'zzz-secret'], c: true })
    expect(errs.map(e => e.path)).toEqual(['$.a', '$.b[1]', '$.c'])
    expect(JSON.stringify(errs)).not.toContain('zzz-secret')
  })
  test('missing required', () => expect(validate(s, {})).toEqual([{ path: '$.a', message: 'is required and missing' }]))
  test('number accepts integers, integer refuses fractions, NaN/Infinity/undefined are not JSON', () => {
    expect(validate(compiled({ type: 'number' }), 2)).toEqual([])
    expect(validate(compiled({ type: 'integer' }), 2.5).length).toBe(1)
    expect(validate(compiled({ type: 'number' }), Number.NaN).length).toBe(1)
    expect(validate(compiled({ type: 'number' }), Infinity).length).toBe(1)
    expect(validate(compiled({ type: 'object' }), { a: undefined }).length).toBe(1)
  })
  test('a cyclic structure is refused, not recursed into forever', () => {
    const o: Record<string, unknown> = {}
    o.self = o
    expect(validate(compiled({ type: 'object' }), o).length).toBe(1)
  })
  test('enum compares structurally, ignoring key order', () => {
    const e = compiled({ enum: [{ a: 1, b: [1, 2] }] })
    expect(validate(e, { b: [1, 2], a: 1 })).toEqual([])
    expect(validate(e, { a: 1, b: [2, 1] }).length).toBe(1)
  })
  test('the model is shown at most MAX_REPORTED_ERRORS lines plus the count of the rest', () => {
    const many = compiled({ type: 'array', items: { type: 'string' } })
    const errs = validate(many, Array.from({ length: 30 }, (_, i) => i))
    expect(errs.length).toBe(30)
    const lines = formatValidationErrors(errs).split('\n')
    expect(lines.length).toBe(MAX_REPORTED_ERRORS + 1)
    expect(lines.at(-1)).toContain('10 more')
  })
})

// ── Property: validate ≡ a naive reference over the same subset ─────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = () => number
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
const KEYS = ['a', 'b', 'c', 'd']
const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean'] as const

function genPrimitive(r: Rng): unknown {
  return pick(r, [null, true, false, 0, 1, -2, 1.5, 3, '', 'x', 'y', 'hello'])
}

function genAnyValue(r: Rng, depth: number): unknown {
  const k = r()
  if (depth <= 0 || k < 0.5) return genPrimitive(r)
  if (k < 0.75) return Array.from({ length: Math.floor(r() * 3) }, () => genAnyValue(r, depth - 1))
  const o: Record<string, unknown> = {}
  for (const key of KEYS) if (r() < 0.4) o[key] = genAnyValue(r, depth - 1)
  return o
}

/** A raw schema INSIDE the subset (so compile never refuses it for keywords). */
function genSchema(r: Rng, depth: number): Record<string, unknown> {
  const t = depth <= 0 ? pick(r, ['string', 'number', 'integer', 'boolean'] as const) : pick(r, TYPES)
  const s: Record<string, unknown> = {}
  if (r() < 0.9) s.type = t
  if (r() < 0.25) s.enum = Array.from({ length: Math.floor(r() * 4) }, () => genAnyValue(r, 1))
  if (s.type === undefined && s.enum === undefined) s.type = t
  if (t === 'object' && s.type === 'object') {
    if (r() < 0.8) {
      const props: Record<string, unknown> = {}
      for (const key of KEYS) if (r() < 0.5) props[key] = genSchema(r, depth - 1)
      s.properties = props
    }
    if (r() < 0.6) s.required = KEYS.filter(() => r() < 0.3)
    if (r() < 0.5) s.additionalProperties = false
  }
  if (t === 'array' && s.type === 'array' && r() < 0.8) s.items = genSchema(r, depth - 1)
  return s
}

/** A value built to MATCH the schema where it can, with occasional deliberate mistakes. */
function genValueFor(r: Rng, s: Record<string, unknown>, depth: number): unknown {
  if (r() < 0.08) return genAnyValue(r, 2)
  if (Array.isArray(s.enum) && s.enum.length > 0 && r() < 0.7) return structuredClone(pick(r, s.enum))
  switch (s.type) {
    case 'string': return pick(r, ['', 'x', 'y', 'hello'])
    case 'integer': return pick(r, [0, 1, -2, 3])
    case 'number': return pick(r, [0, 1.5, -2, 3])
    case 'boolean': return r() < 0.5
    case 'array': {
      const items = s.items as Record<string, unknown> | undefined
      return Array.from({ length: Math.floor(r() * 3) }, () => (items && depth > 0 ? genValueFor(r, items, depth - 1) : genPrimitive(r)))
    }
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, Record<string, unknown>>
      const o: Record<string, unknown> = {}
      const keys = new Set([...Object.keys(props), ...((s.required as string[] | undefined) ?? [])])
      for (const key of keys) {
        if (r() < 0.85) o[key] = props[key] && depth > 0 ? genValueFor(r, props[key]!, depth - 1) : genPrimitive(r)
      }
      if (r() < 0.1) o.zz = 1
      return o
    }
    default: return genAnyValue(r, 1)
  }
}

/**
 * The REFERENCE: a second implementation, deliberately naive — boolean only, no paths, enum by a
 * canonical string, every rule written from the keyword list rather than from `schema.ts`.
 */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

function refAccepts(s: Record<string, unknown>, v: unknown): boolean {
  const isObj = v !== null && typeof v === 'object' && !Array.isArray(v)
  if (s.type === 'object' && !isObj) return false
  if (s.type === 'array' && !Array.isArray(v)) return false
  if (s.type === 'string' && typeof v !== 'string') return false
  if (s.type === 'boolean' && typeof v !== 'boolean') return false
  if (s.type === 'number' && typeof v !== 'number') return false
  if (s.type === 'integer' && !(typeof v === 'number' && Math.floor(v) === v)) return false
  if (Array.isArray(s.enum) && !s.enum.map(canon).includes(canon(v))) return false
  if (isObj) {
    const o = v as Record<string, unknown>
    const props = (s.properties ?? {}) as Record<string, Record<string, unknown>>
    for (const key of (s.required as string[] | undefined) ?? []) if (!(key in o)) return false
    for (const key of Object.keys(o)) {
      if (key in props) { if (!refAccepts(props[key]!, o[key])) return false }
      else if (s.additionalProperties === false) return false
    }
  }
  if (Array.isArray(v) && s.items) return v.every(x => refAccepts(s.items as Record<string, unknown>, x))
  return true
}

describe('validate — property: agrees with the naive reference', () => {
  const SEEDS = 400
  const VALUES_PER_SCHEMA = 25

  test(`${SEEDS} schemas x ${VALUES_PER_SCHEMA} values`, () => {
    let accepted = 0
    let rejected = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = mulberry32(seed)
      const raw = genSchema(r, 3)
      const c = compileSchema(raw)
      // The generator stays inside the subset: a refusal here can only be unsatisfiability.
      if (!c.ok && !c.unsatisfiable) throw new Error(`seed ${seed}: ${c.problems.join(' ')} for ${JSON.stringify(raw)}`)
      for (let i = 0; i < VALUES_PER_SCHEMA; i++) {
        const v = genValueFor(r, raw, 3)
        const ref = refAccepts(raw, v)
        if (!c.ok) {
          // Unsatisfiable means NOTHING is accepted — the reference must agree on every sample.
          if (ref) throw new Error(`seed ${seed}: compile said unsatisfiable, reference accepts ${JSON.stringify(v)} for ${JSON.stringify(raw)}`)
          continue
        }
        const got = validate(c.schema, v).length === 0
        if (got !== ref) {
          throw new Error(`seed ${seed} value ${i}: validate=${got} reference=${ref}\nschema ${JSON.stringify(raw)}\nvalue  ${JSON.stringify(v)}`)
        }
        if (got) accepted++
        else rejected++
      }
    }
    // Both sides of the equivalence were exercised, not only the easy one.
    expect(accepted).toBeGreaterThan(SEEDS * VALUES_PER_SCHEMA * 0.1)
    expect(rejected).toBeGreaterThan(SEEDS * VALUES_PER_SCHEMA * 0.1)
  })

  test('validate is pure: same input, same answer, input untouched', () => {
    const r = mulberry32(7)
    for (let i = 0; i < 100; i++) {
      const raw = genSchema(r, 3)
      const c = compileSchema(raw)
      if (!c.ok) continue
      const v = genValueFor(r, raw, 3)
      const before = JSON.stringify(v)
      const a = validate(c.schema, v)
      const b = validate(c.schema, v)
      expect(b).toEqual(a)
      expect(JSON.stringify(v)).toBe(before)
    }
  })
})
