// The JSON Schema subset the machine contract is written in (docs/specs/contract/openapi/machine-v1.yaml),
// checked with no dependency. The public `@agentistics/contract` package carries the same checker, so
// both repositories hold the fixtures to the same rules.
//
// Keywords: type (one or a list), enum, const, pattern, minLength, maxLength, minimum, maximum,
// maxItems, maxProperties, propertyNames, properties, required, additionalProperties (boolean or
// schema), items, oneOf, $ref (a JSON pointer inside the same document; sibling keywords also apply),
// and `x-null-means-absent` (a key whose value is null is treated as not sent, as the Cloud does).
// Any other keyword fails loudly, so the spec cannot start relying on one this checker ignores.

export type Schema = Record<string, unknown>

const KNOWN = new Set([
  'type', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'maxItems', 'maxProperties',
  'propertyNames', 'properties', 'required', 'additionalProperties', 'items', 'oneOf', '$ref', 'description', 'format',
  'x-null-means-absent',
])

function resolve(root: unknown, ref: string): Schema {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`)
  let node: unknown = root
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
    if (node === undefined) throw new Error(`unresolved $ref ${ref}`)
  }
  return node as Schema
}

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v

const typeMatches = (want: string, v: unknown) => {
  const got = typeOf(v)
  return want === got || (want === 'number' && got === 'integer')
}

/** Every problem with `value` against `schema`, as `path: what`. Empty when it validates. */
export function validate(root: unknown, schema: Schema, value: unknown, path = '$'): string[] {
  const errors: string[] = []
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`${path}: schema keyword ${k} is outside the contract subset`)

  if (typeof schema.$ref === 'string') errors.push(...validate(root, resolve(root, schema.$ref), value, path))

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string]
    if (!types.some((t) => typeMatches(t, value))) return [...errors, `${path}: expected ${types.join('|')}, got ${typeOf(value)}`]
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`)
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Schema[]).filter((s) => validate(root, s, value, path).length === 0).length
    if (passing !== 1) errors.push(`${path}: matches ${passing} of oneOf, expected exactly 1`)
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`)
    if (schema.items) value.forEach((v, i) => errors.push(...validate(root, schema.items as Schema, v, `${path}[${i}]`)))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = schema['x-null-means-absent'] === true
      ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null))
      : (value as Record<string, unknown>)
    const keys = Object.keys(o)
    const props = (schema.properties ?? {}) as Record<string, Schema>
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) errors.push(`${path}: more than ${schema.maxProperties} properties`)
    for (const r of (schema.required ?? []) as string[]) if (!(r in o)) errors.push(`${path}: missing ${r}`)
    for (const k of keys) {
      if (schema.propertyNames) errors.push(...validate(root, schema.propertyNames as Schema, k, `${path}.<key ${JSON.stringify(k)}>`))
      if (props[k]) errors.push(...validate(root, props[k]!, o[k], `${path}.${k}`))
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${k}`)
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validate(root, schema.additionalProperties as Schema, o[k], `${path}.${k}`))
      }
    }
  }
  return errors
}

/** Keywords outside the subset, anywhere under `schema` (without following $ref). Empty when clean. */
export function unknownKeywords(schema: Schema, path = '$'): string[] {
  const out = Object.keys(schema).filter((k) => !KNOWN.has(k)).map((k) => `${path}: ${k}`)
  const child = (s: unknown, p: string) => (s && typeof s === 'object' && !Array.isArray(s) ? unknownKeywords(s as Schema, p) : [])
  for (const [k, s] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) out.push(...child(s, `${path}.properties.${k}`))
  for (const k of ['items', 'additionalProperties', 'propertyNames'] as const) out.push(...child(schema[k], `${path}.${k}`))
  for (const [i, s] of ((schema.oneOf ?? []) as unknown[]).entries()) out.push(...child(s, `${path}.oneOf[${i}]`))
  return out
}
