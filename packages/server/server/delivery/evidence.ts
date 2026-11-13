/**
 * delivery/evidence.ts — the evidence validators and probe shapes of ENTREGA.GARANTIDA rule (a)
 * (spec §3.1 table, §4.5 shapes). PURE: bytes in, a verdict out. No IO, no git, no clock, no store.
 *
 * What lives here (S1a) and what does not:
 *  - the five validators (`validateScreenshot` by header BYTES, `validateApiCapture`, `validateTestLog`,
 *    `validateReport`, `validateProbe`) — every refusal carries a stable `rule` name that the door turns into
 *    `evidence_invalid`;
 *  - `buildEvidenceItem`, the attach-time composition: the SERVER computes the sha256 and takes revision/HEAD/
 *    cleanliness/time from the caller's trusted context — a hash or time inside the payload is never read;
 *  - `checkReuse`: a sha256 backs evidence on at most one piece AND one revision, forever.
 *  NOT here: probe execution (S6a), the REST/MCP/CLI verbs (S1c), the store guard (S2a), classification (S1b).
 *  `repoRef` existence/reachability is a git fact; the caller gathers it and passes `facts`.
 */
import { createHash, randomUUID } from 'node:crypto'

export type EvidenceKind = 'screenshot' | 'api-capture' | 'test-log' | 'report' | 'probe'
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ['screenshot', 'api-capture', 'test-log', 'report', 'probe']

export type Probe =
  | { kind: 'http'; path: string; expect: { status: number; pointer?: string; equals?: unknown; matches?: string; exists?: boolean } }
  | { kind: 'bundle'; literal: string }
  | { kind: 'cli'; argv: string[]; expect: { exit: number; stdoutMatches?: string } }
  | { kind: 'structural'; reason: string; testLogId: string }
export const PROBE_KINDS: readonly Probe['kind'][] = ['http', 'bundle', 'cli', 'structural']

export interface RepoRef { repo: string; sha: string; path: string }

/** `by` is structural until S0a's RequestPrincipal lands (same stance as guards-store.ts). */
export interface EvidenceItem {
  id: string
  kind: EvidenceKind
  fileId?: string
  repoRef?: RepoRef
  sha256: string
  revision: number
  headSha: string | null
  treeClean: boolean
  width?: number
  height?: number
  probe?: Probe
  by: unknown
  at: string
}

export type Verdict = { ok: true } | { ok: false; rule: string; message: string }
const fail = (rule: string, message: string): { ok: false; rule: string; message: string } => ({ ok: false, rule, message })

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

// ── screenshot ───────────────────────────────────────────────────────────────
export const SCREENSHOT_MIN_BYTES = 4 * 1024
export const SCREENSHOT_MIN_W = 320
export const SCREENSHOT_MIN_H = 200

function startsWith(b: Uint8Array, sig: number[], at = 0): boolean { return sig.every((v, i) => b[at + i] === v) }
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))

/** Decoded size read from the header alone. `null` = a recognised container whose size cannot be read. */
function imageSize(b: Uint8Array): { w: number; h: number } | 'unknown' | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    return { w: dv.getUint32(16), h: dv.getUint32(20) }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const m = b[i + 1]!
      if (m === 0xff) { i++; continue }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
      const len = (b[i + 2]! << 8) | b[i + 3]!
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: (b[i + 5]! << 8) | b[i + 6]!, w: (b[i + 7]! << 8) | b[i + 8]! }
      }
      if (len < 2) return null
      i += 2 + len
    }
    return null
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const fourcc = ascii(b, 12, 4)
    if (fourcc === 'VP8 ') {
      if (!startsWith(b, [0x9d, 0x01, 0x2a], 23)) return null
      return { w: (b[26]! | (b[27]! << 8)) & 0x3fff, h: (b[28]! | (b[29]! << 8)) & 0x3fff }
    }
    if (fourcc === 'VP8L') {
      if (b[20] !== 0x2f) return null
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! * 2 ** 24)
      return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (fourcc === 'VP8X') {
      return { w: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), h: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) }
    }
    return null
  }
  return 'unknown'
}

export function validateScreenshot(bytes: Uint8Array): Verdict & { width?: number; height?: number } {
  const size = imageSize(bytes)
  if (size === 'unknown') return fail('screenshot-not-an-image', 'the file is not a PNG, JPEG or WebP (checked by its header bytes, not its name)')
  if (size === null) return fail('screenshot-header-unreadable', 'the image header is truncated or malformed, so its size cannot be read')
  if (size.w < SCREENSHOT_MIN_W || size.h < SCREENSHOT_MIN_H) {
    return fail('screenshot-too-small-dimensions', `the image is ${size.w}×${size.h}; a screenshot must be at least ${SCREENSHOT_MIN_W}×${SCREENSHOT_MIN_H}`)
  }
  if (bytes.length < SCREENSHOT_MIN_BYTES) return fail('screenshot-too-small-bytes', `the file is ${bytes.length} bytes; a screenshot must be at least 4 KB`)
  return { ok: true, width: size.w, height: size.h }
}

// ── api-capture ──────────────────────────────────────────────────────────────
export const API_CAPTURE_MAX_BYTES = 1024 * 1024

function decodeUtf8(bytes: Uint8Array): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
}

export function validateApiCapture(bytes: Uint8Array): Verdict {
  if (bytes.length === 0) return fail('api-capture-empty', 'the capture is empty')
  if (bytes.length > API_CAPTURE_MAX_BYTES) return fail('api-capture-too-large', 'the capture is larger than 1 MB')
  const text = decodeUtf8(bytes)
  if (text === null) return fail('api-capture-not-utf8', 'the capture is not valid UTF-8')
  const statusLine = /^HTTP\/\d(?:\.\d)?\s+\d{3}\b.*$/m.exec(text)
  const jsonStatus = /"status"\s*:\s*\d+/.test(text)
  const requestLine = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+/m.test(text)
  if (!statusLine && !jsonStatus && !requestLine) return fail('api-capture-no-status', 'the capture has no request line, status line or "status": <int>')
  if (!statusLine && !jsonStatus) return fail('api-capture-no-status', 'the capture names a request but no response status')
  let body: string
  if (statusLine) {
    const after = text.slice(statusLine.index + statusLine[0].length)
    const sep = after.search(/\r?\n\r?\n/)
    body = sep === -1 ? '' : after.slice(sep)
  } else body = text
  if (body.trim() === '') return fail('api-capture-empty-body', 'the capture has a status but no response body')
  return { ok: true }
}

// ── test-log ─────────────────────────────────────────────────────────────────
export function validateTestLog(bytes: Uint8Array): Verdict {
  const text = decodeUtf8(bytes)
  if (text === null || text.trim() === '') return fail('test-log-unreadable', 'the test log is empty or not UTF-8')
  const pass = /^\s*(\d+)\s+pass\b/m.exec(text)
  const failM = /^\s*(\d+)\s+fail\b/m.exec(text)
  const exits = [...text.matchAll(/agentop run:\s*exit\s+(\d+)/g)].map((m) => Number(m[1]))
  if (failM && Number(failM[1]) > 0) return fail('test-log-has-failures', `the log reports ${failM[1]} failing test(s)`)
  if (exits.some((e) => e !== 0)) return fail('test-log-nonzero-exit', 'the agentop run footer reports a non-zero exit')
  if (pass && Number(pass[1]) >= 1 && failM) return { ok: true }
  if (exits.length > 0 && exits.every((e) => e === 0)) return { ok: true }
  return fail('test-log-no-summary', 'the log has no runner summary with ≥ 1 pass and 0 fail, and no `agentop run` footer with exit 0')
}

// ── report ───────────────────────────────────────────────────────────────────
export const REPORT_MIN_BYTES = 300
const SHA_RE = /^[0-9a-f]{40}$/
export interface RepoRefFacts { exists: boolean; reachableFromRemote: boolean }

export function validateRepoRefShape(ref: RepoRef): Verdict {
  if (!ref || typeof ref.repo !== 'string' || ref.repo === '') return fail('report-ref-malformed', 'repoRef.repo is missing')
  if (!SHA_RE.test(ref.sha ?? '')) return fail('report-ref-malformed', 'repoRef.sha must be a full 40-hex commit')
  const p = ref.path
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.split('/').includes('..') || p.includes('\0')) {
    return fail('report-ref-malformed', 'repoRef.path must be a relative path inside the repository')
  }
  return { ok: true }
}

export function validateReport(input: { bytes?: Uint8Array; repoRef?: RepoRef; facts?: RepoRefFacts }): Verdict {
  if (input.repoRef) {
    const shape = validateRepoRefShape(input.repoRef)
    if (!shape.ok) return shape
    if (!input.facts || !input.facts.exists) return fail('report-ref-missing', 'the sha:path was not found in the repository')
    if (!input.facts.reachableFromRemote) return fail('report-ref-unpushed', 'the commit is not reachable from a remote branch — push it first')
    return { ok: true }
  }
  if (!input.bytes) return fail('report-no-content', 'a report needs a markdown file or a repoRef')
  if (input.bytes.length < REPORT_MIN_BYTES) return fail('report-too-small', `the report is ${input.bytes.length} bytes; it must be at least ${REPORT_MIN_BYTES}`)
  const text = decodeUtf8(input.bytes)
  if (text === null) return fail('report-not-utf8', 'the report is not valid UTF-8')
  if (!/^(?:Verdict|Veredito|Result|Resultado)\s*:/m.test(text)) return fail('report-no-verdict', 'the report has no line starting with Verdict:/Veredito:/Result:/Resultado:')
  return { ok: true }
}

// ── probes ───────────────────────────────────────────────────────────────────
/**
 * argv prefixes the `cli` probe may run (read-only verbs of the installed binary). S6a executes them; the list is
 * owned here so attach-time validation and the runner cannot disagree. Adding a verb is a reviewed change.
 */
export const READONLY_CLI_VERBS: readonly (readonly string[])[] = [
  ['--version'], ['check-update'], ['session', 'ls'], ['session', 'list'], ['task', 'ls'], ['task', 'show'],
  ['events', 'status'], ['hooks', 'status'], ['autostart', 'status'], ['journal', 'status'], ['flow', 'installs'], ['flow', 'status'],
]
const CLI_ARG_RE = /^[A-Za-z0-9._\/=:@,-]+$/
const HTTP_PATH_RE = /^\/api\/[A-Za-z0-9._~\/%:,=&?-]*$/

export interface ProbeContext { headSha: string | null; items: readonly EvidenceItem[] }

function regexOk(src: string): boolean { try { new RegExp(src); return true } catch { return false } }
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n)

export function validateProbe(probe: Probe, ctx: ProbeContext): Verdict {
  if (!probe || typeof probe !== 'object') return fail('probe-not-an-object', 'a probe must be an object')
  switch (probe.kind) {
    case 'http': {
      if (typeof probe.path !== 'string' || !HTTP_PATH_RE.test(probe.path) || probe.path.split(/[/?]/).includes('..')) {
        return fail('probe-http-bad-path', 'an http probe path must be a plain /api/… path (no host, no "..")')
      }
      const e = probe.expect
      if (!e || !isInt(e.status) || e.status < 100 || e.status > 599) return fail('probe-http-bad-status', 'expect.status must be an integer HTTP status (100–599)')
      if (e.pointer !== undefined && (typeof e.pointer !== 'string' || (e.pointer !== '' && !e.pointer.startsWith('/')))) return fail('probe-http-bad-pointer', 'expect.pointer must be a JSON pointer ("" or "/a/b")')
      if (e.matches !== undefined && (typeof e.matches !== 'string' || !regexOk(e.matches))) return fail('probe-http-bad-regex', 'expect.matches is not a valid regular expression')
      if (e.exists !== undefined && typeof e.exists !== 'boolean') return fail('probe-http-bad-exists', 'expect.exists must be a boolean')
      return { ok: true }
    }
    case 'bundle': {
      if (typeof probe.literal !== 'string' || probe.literal.length < 12) return fail('probe-bundle-literal-short', 'a bundle probe literal must be at least 12 characters')
      return { ok: true }
    }
    case 'cli': {
      if (!Array.isArray(probe.argv) || probe.argv.length === 0 || !probe.argv.every((a) => typeof a === 'string')) return fail('probe-cli-bad-argv', 'a cli probe needs a non-empty argv of strings')
      const allowed = READONLY_CLI_VERBS.some((v) => v.every((t, i) => probe.argv[i] === t))
      if (!allowed) return fail('probe-cli-verb-not-readonly', `"${probe.argv.slice(0, 2).join(' ')}" is not in the read-only verb allowlist`)
      if (!probe.argv.every((a) => CLI_ARG_RE.test(a))) return fail('probe-cli-bad-argv', 'cli probe arguments may only contain letters, digits and . _ / = : @ , -')
      if (!probe.expect || !isInt(probe.expect.exit)) return fail('probe-cli-bad-exit', 'expect.exit must be an integer')
      if (probe.expect.stdoutMatches !== undefined && (typeof probe.expect.stdoutMatches !== 'string' || !regexOk(probe.expect.stdoutMatches))) return fail('probe-cli-bad-regex', 'expect.stdoutMatches is not a valid regular expression')
      return { ok: true }
    }
    case 'structural': {
      if (typeof probe.reason !== 'string' || probe.reason.trim().length < 12) return fail('probe-structural-reason-short', 'a structural probe must say why no read-only probe can observe the change (≥ 12 characters)')
      const log = ctx.items.find((i) => i.id === probe.testLogId && i.kind === 'test-log')
      if (!log) return fail('probe-structural-testlog-missing', 'testLogId must name a test-log evidence on this piece')
      if (log.headSha !== ctx.headSha) return fail('probe-structural-testlog-stale', 'the referenced test log was taken at another commit than the piece\'s HEAD')
      return { ok: true }
    }
    default:
      return fail('probe-kind-unknown', 'a probe is one of http | bundle | cli | structural')
  }
}

/** Key-order-independent JSON: the bytes the probe's sha256 is taken over. */
export function canonicalProbeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalProbeJson).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalProbeJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// ── uniqueness: one sha256, one piece, one revision, forever ─────────────────
export interface ReuseEntry { sha256: string; pieceKey: string; revision: number }
export type ReuseVerdict = { ok: true; duplicate?: true } | { ok: false; code: 'evidence_reused'; message: string }

/**
 * `index` is the caller's whole history (including items since removed — removal frees nothing). The exact same
 * (piece, revision, sha) is an idempotent re-add; any other occurrence of the sha is a reuse.
 */
export function checkReuse(index: readonly ReuseEntry[], c: ReuseEntry): ReuseVerdict {
  const sameSlot = index.some((e) => e.sha256 === c.sha256 && e.pieceKey === c.pieceKey && e.revision === c.revision)
  const other = index.find((e) => e.sha256 === c.sha256 && !(e.pieceKey === c.pieceKey && e.revision === c.revision))
  if (other) {
    return {
      ok: false, code: 'evidence_reused',
      message: `These exact bytes already back evidence on piece ${other.pieceKey} at revision ${other.revision}. Evidence is unique per piece and revision: capture it again.`,
    }
  }
  return sameSlot ? { ok: true, duplicate: true } : { ok: true }
}

// ── attach-time composition ──────────────────────────────────────────────────
export interface AttachInput {
  kind: EvidenceKind
  fileId?: string
  bytes?: Uint8Array
  repoRef?: RepoRef
  facts?: RepoRefFacts
  probe?: Probe
}
export interface AttachContext {
  revision: number
  headSha: string | null
  treeClean: boolean
  by: unknown
  at: string
  /** the piece's current evidence items (for the structural probe's test-log link) */
  items: readonly EvidenceItem[]
  pieceKey?: string
  reuseIndex?: readonly ReuseEntry[]
}
export type AttachResult =
  | { ok: true; item: EvidenceItem; duplicate?: true }
  | { ok: false; code: 'evidence_invalid' | 'evidence_reused'; rule: string; message: string }

const invalid = (rule: string, message: string): AttachResult => ({ ok: false, code: 'evidence_invalid', rule, message })

export function buildEvidenceItem(input: AttachInput, ctx: AttachContext): AttachResult {
  if (!input || !EVIDENCE_KINDS.includes(input.kind)) return invalid('kind-unknown', 'evidence kind must be screenshot | api-capture | test-log | report | probe')
  let sha256: string
  let dims: { width: number; height: number } | undefined
  let probe: Probe | undefined
  let repoRef: RepoRef | undefined

  if (input.kind === 'probe') {
    if (!input.probe) return invalid('payload-missing', 'a probe item needs a probe')
    const v = validateProbe(input.probe, { headSha: ctx.headSha, items: ctx.items })
    if (!v.ok) return invalid(v.rule, v.message)
    probe = input.probe
    sha256 = sha256Hex(new TextEncoder().encode(canonicalProbeJson(probe)))
  } else if (input.kind === 'report' && input.repoRef && !input.bytes) {
    const v = validateReport({ repoRef: input.repoRef, facts: input.facts })
    if (!v.ok) return invalid(v.rule, v.message)
    repoRef = input.repoRef
    sha256 = sha256Hex(new TextEncoder().encode(`${repoRef.repo}@${repoRef.sha}:${repoRef.path}`))
  } else {
    const bytes = input.bytes
    if (!(bytes instanceof Uint8Array)) return invalid('payload-missing', `a ${input.kind} item needs the file's bytes`)
    let v: Verdict & { width?: number; height?: number }
    if (input.kind === 'screenshot') v = validateScreenshot(bytes)
    else if (input.kind === 'api-capture') v = validateApiCapture(bytes)
    else if (input.kind === 'test-log') v = validateTestLog(bytes)
    else v = validateReport({ bytes })
    if (!v.ok) return invalid(v.rule, v.message)
    if (v.width !== undefined && v.height !== undefined) dims = { width: v.width, height: v.height }
    sha256 = sha256Hex(bytes)
  }

  let duplicate: true | undefined
  if (ctx.reuseIndex && ctx.pieceKey !== undefined) {
    const r = checkReuse(ctx.reuseIndex, { sha256, pieceKey: ctx.pieceKey, revision: ctx.revision })
    if (!r.ok) return { ok: false, code: r.code, rule: 'evidence-reused', message: r.message }
    duplicate = r.duplicate
  }

  const item: EvidenceItem = {
    id: `ev-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    kind: input.kind,
    ...(input.fileId !== undefined ? { fileId: input.fileId } : {}),
    ...(repoRef ? { repoRef } : {}),
    sha256,
    revision: ctx.revision,
    headSha: ctx.headSha,
    treeClean: ctx.treeClean,
    ...(dims ?? {}),
    ...(probe ? { probe } : {}),
    by: ctx.by,
    at: ctx.at,
  }
  return duplicate ? { ok: true, item, duplicate } : { ok: true, item }
}
