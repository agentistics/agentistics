/**
 * structured/schema.ts — the JSON-Schema SUBSET a structured result is checked against (TOOL.1, spec
 * 2026-09-28-runtime-planning-orchestration-artifacts.md §6.1). Pure: no I/O, no clock, no globals.
 *
 * ## The subset, and nothing else
 *
 * `type` (one of `object`, `array`, `string`, `number`, `integer`, `boolean`), `enum`, `required`,
 * `items`, `additionalProperties: false` — plus `properties`, which the spec's list does not name but
 * which `required` and `additionalProperties` are meaningless without. Every other keyword is REFUSED
 * with a sentence naming it and where it sits — never ignored. A validator that silently skips
 * `pattern` accepts values the author believed were checked, which is worse than refusing the schema
 * (B8 §3.2's stance). That includes `description`: a keyword the validator does not read is still a
 * keyword somebody may believe constrains something.
 *
 * ## Satisfiability is checked before anything is billed
 *
 * `compileSchema` also proves the schema can be satisfied at all, so an impossible request is refused
 * before a provider call rather than after `maxRetries + 1` paid responses that could never succeed:
 * an empty `enum`, an `enum` none of whose values has the node's `type`, a `required` key absent from
 * `properties` under `additionalProperties: false`, and — recursively — a required property whose own
 * schema is unsatisfiable. An OPTIONAL property or an array's `items` being unsatisfiable does not
 * make its parent unsatisfiable (omit the key; send `[]`), so those are accepted.
 */

export const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean'] as const
export type SchemaType = (typeof SCHEMA_TYPES)[number]

/** The only keywords a structured-result schema may carry. */
export const SCHEMA_KEYWORDS = ['type', 'enum', 'properties', 'required', 'items', 'additionalProperties'] as const

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

/** A schema that passed `compileSchema`: every field is already checked to be in the subset. */
export interface Schema {
  type?: SchemaType
  enum?: readonly JsonValue[]
  properties?: Readonly<Record<string, Schema>>
  required?: readonly string[]
  items?: Schema
  /** Only ever `false`; absent = extra keys are allowed. */
  additionalProperties?: false
}

export type CompileResult =
  | { ok: true; schema: Schema }
  /** `problems` are sentences, one per defect, each naming the keyword and the path. */
  | { ok: false; problems: string[]; unsatisfiable: boolean }

export interface ValidationError {
  /** `$`, `$.a`, `$.list[2]` — a location, never the value found there. */
  path: string
  message: string
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}

/** Structural equality over JSON values; key order is irrelevant, as in JSON Schema's `enum`. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => jsonEqual(x, b[i]))
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false
    const ka = Object.keys(a)
    if (ka.length !== Object.keys(b).length) return false
    return ka.every(k => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
  }
  return false
}

/** Whether `v` is a JSON value at all (finite numbers, plain objects, no `undefined`/functions). */
function isJsonValue(v: unknown, depth = 0): boolean {
  if (depth > 64) return false
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every(x => isJsonValue(x, depth + 1))
  if (isPlainObject(v)) return Object.values(v).every(x => isJsonValue(x, depth + 1))
  return false
}

function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

/** Whether a value has the given subset type. `number` accepts integers; `integer` only integers. */
export function hasType(v: unknown, t: SchemaType): boolean {
  switch (t) {
    case 'object': return isPlainObject(v)
    case 'array': return Array.isArray(v)
    case 'string': return typeof v === 'string'
    case 'boolean': return typeof v === 'boolean'
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'integer': return typeof v === 'number' && Number.isInteger(v)
  }
}

// ── Compile: the subset check + the satisfiability check ────────────────────────────────────────

const MAX_DEPTH = 32

export function compileSchema(raw: unknown): CompileResult {
  const problems: string[] = []
  const schema = compileNode(raw, '$', problems, 0)
  if (problems.length > 0 || schema === null) return { ok: false, problems, unsatisfiable: false }
  const unsat: string[] = []
  unsatisfiableReasons(schema, '$', unsat)
  if (unsat.length > 0) return { ok: false, problems: unsat, unsatisfiable: true }
  return { ok: true, schema }
}

function compileNode(raw: unknown, path: string, problems: string[], depth: number): Schema | null {
  if (depth > MAX_DEPTH) {
    problems.push(`The schema at ${path} is nested deeper than ${MAX_DEPTH} levels, which is not supported.`)
    return null
  }
  if (!isPlainObject(raw)) {
    problems.push(`The schema at ${path} must be an object; it is ${typeName(raw)}.`)
    return null
  }
  const before = problems.length
  for (const k of Object.keys(raw)) {
    if (!(SCHEMA_KEYWORDS as readonly string[]).includes(k)) {
      problems.push(
        `The keyword "${k}" at ${path} is not supported: a structured-result schema may use only ` +
        `${SCHEMA_KEYWORDS.join(', ')} (additionalProperties only as false).`,
      )
    }
  }
  const out: Schema = {}

  if ('type' in raw) {
    const t = raw.type
    if (typeof t !== 'string' || !(SCHEMA_TYPES as readonly string[]).includes(t)) {
      problems.push(
        `The "type" at ${path} must be one of ${SCHEMA_TYPES.join(', ')}; ${JSON.stringify(t) ?? 'undefined'} is not supported ` +
        `(a list of types, and "null", are outside the subset).`,
      )
    } else out.type = t as SchemaType
  }

  if ('enum' in raw) {
    const e = raw.enum
    if (!Array.isArray(e)) problems.push(`The "enum" at ${path} must be an array.`)
    else if (!e.every(v => isJsonValue(v))) problems.push(`The "enum" at ${path} must hold JSON values only.`)
    else out.enum = e as JsonValue[]
  }

  if (!('type' in raw) && !('enum' in raw)) {
    problems.push(`The schema at ${path} states neither "type" nor "enum", so it constrains nothing; state one.`)
  }

  const objectOnly = (['properties', 'required', 'additionalProperties'] as const).filter(k => k in raw)
  if (objectOnly.length > 0 && out.type !== undefined && out.type !== 'object') {
    problems.push(`The keyword "${objectOnly[0]}" at ${path} applies only to type "object", and this schema is "${out.type}".`)
  }
  if ('items' in raw && out.type !== undefined && out.type !== 'array') {
    problems.push(`The keyword "items" at ${path} applies only to type "array", and this schema is "${out.type}".`)
  }

  if ('properties' in raw) {
    const p = raw.properties
    if (!isPlainObject(p)) problems.push(`The "properties" at ${path} must be an object mapping names to schemas.`)
    else {
      const props: Record<string, Schema> = {}
      for (const [name, sub] of Object.entries(p)) {
        const c = compileNode(sub, childPath(path, name), problems, depth + 1)
        if (c) props[name] = c
      }
      out.properties = props
    }
  }

  if ('required' in raw) {
    const r = raw.required
    if (!Array.isArray(r) || !r.every(x => typeof x === 'string')) {
      problems.push(`The "required" at ${path} must be an array of property names.`)
    } else if (new Set(r).size !== r.length) {
      problems.push(`The "required" at ${path} names the same property twice.`)
    } else out.required = r as string[]
  }

  if ('additionalProperties' in raw) {
    if (raw.additionalProperties !== false) {
      problems.push(
        `The "additionalProperties" at ${path} is supported only as false; ${JSON.stringify(raw.additionalProperties)} is not ` +
        `(omit it to allow extra keys).`,
      )
    } else out.additionalProperties = false
  }

  if ('items' in raw) {
    const c = compileNode(raw.items, `${path}[]`, problems, depth + 1)
    if (c) out.items = c
  }

  return problems.length > before ? null : out
}

/** Collects why a compiled schema can never be satisfied; empty = some value satisfies it. */
function unsatisfiableReasons(s: Schema, path: string, out: string[]): void {
  if (s.enum !== undefined) {
    if (s.enum.length === 0) { out.push(`The "enum" at ${path} is empty, so no value can ever match it.`); return }
    // An enum value that satisfies the WHOLE node witnesses it; the enum is the node's only freedom.
    if (!s.enum.some(v => validate(s, v).length === 0)) {
      out.push(
        s.type !== undefined && !s.enum.some(v => hasType(v, s.type!))
          ? `No value of the "enum" at ${path} has the type "${s.type}", so no value can ever match it.`
          : `No value of the "enum" at ${path} satisfies the rest of the schema there, so no value can ever match it.`,
      )
    }
    return
  }
  if (s.type !== 'object') return
  const props = s.properties ?? {}
  for (const key of s.required ?? []) {
    const sub = props[key]
    if (sub === undefined) {
      if (s.additionalProperties === false) {
        out.push(`The property "${key}" is required at ${path} but is not in "properties", and additionalProperties is false, so no object can satisfy both.`)
      }
      continue
    }
    unsatisfiableReasons(sub, childPath(path, key), out)
  }
}

// ── Validate ────────────────────────────────────────────────────────────────────────────────────

/** How many errors the model is shown; `validate` itself returns every one (the count is journaled). */
export const MAX_REPORTED_ERRORS = 20

/**
 * Every place `value` departs from `schema`. Empty = valid. Pure and total: any input, including
 * cyclic or non-JSON ones, yields an answer rather than a throw.
 */
export function validate(schema: Schema, value: unknown): ValidationError[] {
  // Checked once, at the root: a cyclic structure or a non-JSON leaf (undefined, NaN, a function)
  // never came out of a JSON parse, and the walk below may then assume a finite tree.
  if (!isJsonValue(value)) return [{ path: '$', message: `expected a JSON value, got ${typeName(value)} (or a structure JSON cannot express)` }]
  const errors: ValidationError[] = []
  walk(schema, value as JsonValue, '$', errors)
  return errors
}

function walk(s: Schema, v: JsonValue, path: string, errors: ValidationError[]): void {
  if (s.type !== undefined && !hasType(v, s.type)) {
    errors.push({ path, message: `expected ${s.type === 'integer' || s.type === 'array' || s.type === 'object' ? 'an' : 'a'} ${s.type}, got ${typeName(v)}` })
    return
  }
  if (s.enum !== undefined && !s.enum.some(e => jsonEqual(e, v))) {
    const shown = s.enum.slice(0, 8).map(e => JSON.stringify(e)).join(', ')
    errors.push({ path, message: `expected one of ${shown}${s.enum.length > 8 ? ', …' : ''}` })
  }
  if (isPlainObject(v)) {
    const props = s.properties ?? {}
    for (const key of s.required ?? []) {
      if (!Object.hasOwn(v, key)) errors.push({ path: childPath(path, key), message: 'is required and missing' })
    }
    for (const key of Object.keys(v).sort()) {
      const sub = props[key]
      if (sub !== undefined) walk(sub, v[key]!, childPath(path, key), errors)
      else if (s.additionalProperties === false) errors.push({ path: childPath(path, key), message: 'is not an allowed property' })
    }
  }
  if (Array.isArray(v) && s.items !== undefined) {
    v.forEach((item, i) => walk(s.items!, item, `${path}[${i}]`, errors))
  }
}

/** The errors as the model reads them: one line each, capped, with the count of the rest. */
export function formatValidationErrors(errors: readonly ValidationError[]): string {
  const shown = errors.slice(0, MAX_REPORTED_ERRORS).map(e => `- ${e.path}: ${e.message}`)
  if (errors.length > MAX_REPORTED_ERRORS) shown.push(`- … and ${errors.length - MAX_REPORTED_ERRORS} more`)
  return shown.join('\n')
}
