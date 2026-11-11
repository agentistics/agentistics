/**
 * redact.ts — strip credentials out of free text before it leaves the machine.
 *
 * WHY THIS EXISTS: free text a person typed or pasted — a session's opening message, a note, an
 * agent's report — can carry a credential. Pasting `DATABASE_URL=postgres://user:pass@host` as the
 * opening message of a session is enough for a production credential to land, in plaintext, in a
 * notification, an audit line or a push message. That is not hypothetical: it is how this module
 * came to be written.
 *
 * DESIGN CONSTRAINT — precision matters more than reach. `first_prompt` is what labels a session
 * in every list in the product. A redactor that also eats `input_tokens=123` or "the token count
 * was 1500" turns every label into noise, and the first thing anyone does with a noisy redactor
 * is disable it. So every generic rule below is guarded by a value-shape test: a secret is long,
 * mixed-character, and not a plain number or an obvious placeholder. When in doubt, this module
 * leaves the text ALONE — it is a safety net for the accidental paste, never a guarantee.
 *
 * It cannot promise to catch everything, and nothing here replaces rotating a leaked credential.
 *
 * Pure and dependency-free.
 */

export const REDACTION = '[REDACTED]'

/** Obvious non-secrets people type where a secret would go. Never redacted. */
const PLACEHOLDER = /^(\*+|x+|\.+|-+|<[^>]*>|\{[^}]*\}|\$\{?[A-Z_][A-Z0-9_]*\}?|your[-_]?\w*|todo|changeme|none|null|nil|empty|redacted|\[redacted\])$/i

/**
 * Does this value LOOK like a credential rather than prose or a number?
 * Requires real length and at least two character classes — the shape a random secret has and
 * `1500`, `30`, `****` or `<your-key-here>` do not.
 */
function looksSecret(value: string): boolean {
  const v = value.trim().replace(/^["']|["']$/g, '')
  if (v.length < 12) return false
  if (PLACEHOLDER.test(v)) return false
  if (/^\d+$/.test(v)) return false          // 1500, 47291
  if (/\s/.test(v)) return false             // prose, not a token
  const classes = [/[a-z]/.test(v), /[A-Z]/.test(v), /\d/.test(v), /[^A-Za-z0-9]/.test(v)]
    .filter(Boolean).length
  return classes >= 2
}

/** Replace with the marker only when the captured value really looks like a secret. */
function guarded(whole: string, prefix: string, value: string): string {
  return looksSecret(value) ? `${prefix}${REDACTION}` : whole
}

// --- High-confidence provider tokens (self-identifying prefixes/shapes) ---------------------
// These carry their own namespace, so matching them is unambiguous — no value guard needed.
const STRONG: RegExp[] = [
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-ant-[A-Za-z0-9\-_]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9\-_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[A-Za-z0-9\-_]{35}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9\-_]{8,}\.eyJ[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]{8,}/g, // JWT
]

/**
 * The password inside a `scheme://user:password@host` URI.
 *
 * Keeps the scheme, the username and the host: those make the text still say WHICH system the
 * session was about, which is the entire value of a session label. Only the password dies.
 */
const URI_CREDENTIAL = /\b([a-z][a-z0-9+.\-]*:\/\/[^\s:/@"']+:)([^\s@"']+)@/gi

/**
 * `KEY=value` / `key: value` for names that mean "this is a secret".
 *
 * The leading `[A-Za-z0-9_]*[_-]` is load-bearing: `\b` does NOT match between `AWS_` and
 * `SECRET`, because `_` is a word character — so an anchored version silently missed
 * `AWS_SECRET_ACCESS_KEY`, the single most famous secret env var there is.
 */
const ASSIGNMENT = /(^|[^A-Za-z0-9_])((?:[A-Za-z0-9]+[_-])*(?:pass(?:word|wd)?|pwd|secret|token|auth|credentials?|api[_-]?key|access[_-]?key|private[_-]?key)[a-z0-9_-]*\s*[:=]\s*)(["']?[^\s"',;]+["']?)/gi

/** `Authorization: Bearer <token>` and bare `Bearer <token>`. */
const BEARER = /\b(Bearer\s+)([A-Za-z0-9\-._~+/]{12,}=*)/g

/**
 * Redact credentials from free text. Pure; returns the input unchanged when nothing matches
 * (same string identity is not guaranteed, but equality is).
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text === '') return ''
  let out = text

  for (const re of STRONG) out = out.replace(re, REDACTION)

  out = out.replace(URI_CREDENTIAL, (whole, prefix: string, pw: string) =>
    // A URI password is a secret by position — a short one is still a password. The only thing
    // excluded is an obvious placeholder, so `://user:<pass>@host` in a doc snippet survives.
    PLACEHOLDER.test(pw) ? whole : `${prefix}${REDACTION}@`)

  // `lead` is the delimiter before the key name; it is captured (not just consumed) because
  // dropping it glued the previous word onto the key — "run with PASSWORD=x" → "run withPASSWORD=".
  out = out.replace(ASSIGNMENT, (whole, lead: string, prefix: string, value: string) =>
    guarded(whole, `${lead}${prefix}`, value))
  out = out.replace(BEARER, (whole, prefix: string, value: string) => guarded(whole, prefix, value))

  return out
}

/** True when `redactSecrets` would change this text. Useful for logging/telemetry counts. */
export function containsSecret(text: string): boolean {
  return typeof text === 'string' && text !== '' && redactSecrets(text) !== text
}
