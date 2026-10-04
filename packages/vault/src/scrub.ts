/**
 * scrub.ts — VAULT.PERSONAL P2: replace a granted secret's value, and its common encodings, with a
 * marker BEFORE text reaches a model, a transcript, a chat view or a terminal frame. PURE.
 *
 * What it catches: the exact value; base64 (standard and URL-safe, with or without padding); the
 * percent-encoded form (`encodeURIComponent`); hex (lower and upper); and each of those found inside
 * longer text. A value is only scrubbed when it is at least `MIN_SCRUB_LENGTH` characters, because a
 * three-letter "secret" would blank every occurrence of an ordinary word and teach people to ignore
 * the marker.
 *
 * What it does NOT catch, stated (spec §8): a value split into pieces, reversed, re-encoded twice,
 * transformed, hashed and compared, or leaked through a side channel. Scrubbing stops ACCIDENTAL
 * exposure — a program printing its own config, `env`, `curl -v`, an error that echoes the key — not a
 * process that holds the value and is determined to exfiltrate it.
 */
export const MIN_SCRUB_LENGTH = 6

export interface ScrubSecret { name: string; value: string }

/** The marker a scrubbed value becomes: names the secret, carries nothing of it. */
export const scrubMarker = (name: string) => `«vault:${name}»`

function b64(s: string): string { return Buffer.from(s, 'utf8').toString('base64') }

/**
 * Every form one value can take that we replace, longest first (so a base64 form containing the hex of
 * something else is not partially replaced). Forms shorter than the minimum are dropped.
 */
export function scrubForms(value: string): string[] {
  if (value.length < MIN_SCRUB_LENGTH) return []
  const std = b64(value)
  const forms = new Set<string>([
    value,
    std, std.replace(/=+$/, ''),
    std.replace(/\+/g, '-').replace(/\//g, '_'), std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    encodeURIComponent(value),
    Buffer.from(value, 'utf8').toString('hex'), Buffer.from(value, 'utf8').toString('hex').toUpperCase(),
  ])
  // A multi-line value (a PEM key, a .env file) is also caught line by line: a program that prints it
  // reflowed still prints each long line.
  if (value.includes('\n')) for (const line of value.split(/\r?\n/)) if (line.trim().length >= 16) forms.add(line.trim())
  return [...forms].filter(f => f.length >= MIN_SCRUB_LENGTH).sort((a, b) => b.length - a.length)
}

/** A prepared scrubber for a set of secrets: compile once, apply to every chunk. */
export function makeScrubber(secrets: readonly ScrubSecret[]): { scrub: (text: string) => { text: string; hits: string[] }; empty: boolean } {
  const pairs: { form: string; name: string }[] = []
  for (const s of secrets) for (const f of scrubForms(s.value)) pairs.push({ form: f, name: s.name })
  pairs.sort((a, b) => b.form.length - a.form.length)
  return {
    empty: pairs.length === 0,
    scrub(text: string) {
      if (pairs.length === 0 || !text) return { text, hits: [] }
      let out = text
      const hits = new Set<string>()
      for (const p of pairs) {
        if (!out.includes(p.form)) continue
        out = out.split(p.form).join(scrubMarker(p.name))
        hits.add(p.name)
      }
      return { text: out, hits: [...hits] }
    },
  }
}

/**
 * A stream scrubber for output that arrives in chunks (a pty, a pipe): a value may be split across two
 * chunks, so the last `maxForm - 1` characters are held back until the next chunk (or `flush`).
 */
export function makeStreamScrubber(secrets: readonly ScrubSecret[]): { push: (chunk: string) => string; flush: () => string } {
  const s = makeScrubber(secrets)
  const keep = Math.max(0, ...secrets.flatMap(x => scrubForms(x.value)).map(f => f.length)) - 1
  let tail = ''
  return {
    push(chunk: string) {
      if (s.empty) return chunk
      const all = tail + chunk
      const cleaned = s.scrub(all).text
      // Hold back a tail long enough that no form can straddle the boundary unseen.
      if (cleaned.length <= keep) { tail = cleaned; return '' }
      tail = cleaned.slice(cleaned.length - keep)
      return cleaned.slice(0, cleaned.length - keep)
    },
    flush() { const t = s.scrub(tail).text; tail = ''; return t },
  }
}

// ── references ───────────────────────────────────────────────────────────────────────────────

/**
 * `vault://NAME` or `vault://NAME/field` (field ∈ the kind's fields; default the main one). Names may
 * contain letters, digits, `_ . -` and spaces are NOT allowed in a reference (the chip inserts the
 * env-style key). Returned in order of appearance, deduplicated.
 */
export const VAULT_REF = /vault:\/\/([A-Za-z0-9_.-]{1,120})(?:\/(login|password|value))?/g
export function findVaultRefs(text: string): { name: string; field: string | null; raw: string }[] {
  const out: { name: string; field: string | null; raw: string }[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(VAULT_REF)) {
    if (seen.has(m[0])) continue
    seen.add(m[0])
    out.push({ name: m[1]!, field: m[2] ?? null, raw: m[0] })
  }
  return out
}

/** The env var a reference becomes: `VAULT_<NAME>[_<FIELD>]`, upper-cased, non [A-Z0-9_] → `_`. */
export function envNameFor(name: string, field: string | null): string {
  const base = `VAULT_${name}${field ? `_${field}` : ''}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  return base.replace(/_+/g, '_')
}
