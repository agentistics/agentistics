/**
 * S1a — the evidence validators (spec §3.1 table, positive AND negative rows), the Probe shapes, and uniqueness by
 * sha256 per piece-revision (§3.1 "Unique forever"; §3.5.9 forged evidence, §3.5.11 reuse).
 */
import { describe, expect, test } from 'bun:test'
import {
  PROBE_KINDS, READONLY_CLI_VERBS, buildEvidenceItem, canonicalProbeJson, checkReuse, sha256Hex,
  validateApiCapture, validateProbe, validateReport, validateScreenshot, validateTestLog,
  type EvidenceItem, type Probe,
} from './evidence'

// ── byte builders ────────────────────────────────────────────────────────────
const enc = (s: string) => new TextEncoder().encode(s)
function pad(head: Uint8Array, total: number): Uint8Array {
  const out = new Uint8Array(Math.max(total, head.length)); out.set(head); return out
}
function png(w: number, h: number, total = 6000): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const dv = new DataView(b.buffer)
  dv.setUint32(8, 13); b.set(enc('IHDR'), 12); dv.setUint32(16, w); dv.setUint32(20, h)
  return pad(b, total)
}
function jpeg(w: number, h: number, total = 6000): Uint8Array {
  // SOI, APP0 (len 16), SOF0 (len 17): marker FFC0, len, precision, height, width
  const b = new Uint8Array(2 + 18 + 19)
  b.set([0xff, 0xd8], 0)
  b.set([0xff, 0xe0, 0x00, 0x10], 2)
  const o = 20
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], o)
  b[o + 5] = h >> 8; b[o + 6] = h & 255; b[o + 7] = w >> 8; b[o + 8] = w & 255
  return pad(b, total)
}
function webpLossy(w: number, h: number, total = 6000): Uint8Array {
  const b = new Uint8Array(30)
  b.set(enc('RIFF'), 0); b.set(enc('WEBP'), 8); b.set(enc('VP8 '), 12)
  b.set([0x9d, 0x01, 0x2a], 23)
  b[26] = w & 255; b[27] = (w >> 8) & 63; b[28] = h & 255; b[29] = (h >> 8) & 63
  return pad(b, total)
}
function webpExtended(w: number, h: number, total = 6000): Uint8Array {
  const b = new Uint8Array(30)
  b.set(enc('RIFF'), 0); b.set(enc('WEBP'), 8); b.set(enc('VP8X'), 12)
  const w1 = w - 1, h1 = h - 1
  b[24] = w1 & 255; b[25] = (w1 >> 8) & 255; b[26] = (w1 >> 16) & 255
  b[27] = h1 & 255; b[28] = (h1 >> 8) & 255; b[29] = (h1 >> 16) & 255
  return pad(b, total)
}

describe('§3.1 screenshot', () => {
  test('valid PNG / JPEG / WebP records width and height', () => {
    expect(validateScreenshot(png(1280, 800))).toEqual({ ok: true, width: 1280, height: 800 })
    expect(validateScreenshot(jpeg(390, 844))).toEqual({ ok: true, width: 390, height: 844 })
    expect(validateScreenshot(webpLossy(1000, 600))).toEqual({ ok: true, width: 1000, height: 600 })
    expect(validateScreenshot(webpExtended(500, 900))).toEqual({ ok: true, width: 500, height: 900 })
  })
  test('boundary: exactly 320×200 and exactly 4 KB are valid', () => {
    expect(validateScreenshot(png(320, 200, 4096)).ok).toBe(true)
  })
  test('NEG: 1×1 PNG (forged) is refused on the decoded size', () => {
    const r = validateScreenshot(png(1, 1))
    expect(r.ok).toBe(false); if (!r.ok) expect(r.rule).toBe('screenshot-too-small-dimensions')
  })
  test('NEG: 319 wide or 199 tall are refused', () => {
    expect(validateScreenshot(png(319, 800)).ok).toBe(false)
    expect(validateScreenshot(png(800, 199)).ok).toBe(false)
  })
  test('NEG: under 4 KB is refused', () => {
    const r = validateScreenshot(png(1280, 800, 4095))
    expect(r.ok).toBe(false); if (!r.ok) expect(r.rule).toBe('screenshot-too-small-bytes')
  })
  test('NEG: a renamed text file has no image magic', () => {
    const r = validateScreenshot(pad(enc('hello this is not an image '.repeat(300)), 8000))
    expect(r.ok).toBe(false); if (!r.ok) expect(r.rule).toBe('screenshot-not-an-image')
  })
  test('NEG: PNG magic with a truncated header, and a GIF', () => {
    expect(validateScreenshot(pad(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 5000)).ok).toBe(false)
    expect(validateScreenshot(pad(enc('GIF89a'), 5000)).ok).toBe(false)
  })
  test('NEG: JPEG with no SOF marker yields no size → refused', () => {
    expect(validateScreenshot(pad(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), 5000)).ok).toBe(false)
  })
})

describe('§3.1 api-capture', () => {
  const okHttp = 'GET /api/version HTTP/1.1\nHTTP/1.1 200 OK\ncontent-type: application/json\n\n{"version":"2.211.0"}\n'
  test('request line + status line + body is valid', () => { expect(validateApiCapture(enc(okHttp)).ok).toBe(true) })
  test('a `"status": <int>` JSON capture with a body is valid', () => {
    expect(validateApiCapture(enc('{"status": 200, "body": {"a": 1}}')).ok).toBe(true)
  })
  test('NEG: empty body after the status line', () => {
    const r = validateApiCapture(enc('GET /api/x HTTP/1.1\nHTTP/1.1 200 OK\n\n'))
    expect(r.ok).toBe(false); if (!r.ok) expect(r.rule).toBe('api-capture-empty-body')
  })
  test('NEG: a request line alone (no response status) is refused', () => {
    const r = validateApiCapture(enc('GET /api/version HTTP/1.1\n\n{"version":"2.211.0"}\n'))
    expect(r.ok).toBe(false); if (!r.ok) expect(r.rule).toBe('api-capture-no-status')
  })
  test('NEG: plain prose has no request/status line', () => {
    const r = validateApiCapture(enc('it works, trust me\nreally'))
    expect(r.ok).toBe(false); if (!r.ok) expect(r.rule).toBe('api-capture-no-status')
  })
  test('NEG: > 1 MB, invalid UTF-8, empty', () => {
    expect(validateApiCapture(enc(okHttp + 'x'.repeat(1_048_577))).ok).toBe(false)
    expect(validateApiCapture(new Uint8Array([0x47, 0x45, 0x54, 0xff, 0xfe, 0xfd])).ok).toBe(false)
    expect(validateApiCapture(new Uint8Array(0)).ok).toBe(false)
  })
})

describe('§3.1 test-log', () => {
  test('bun test summary: N pass, 0 fail', () => {
    expect(validateTestLog(enc(' 12 pass\n 0 fail\n 30 expect() calls\nRan 12 tests across 1 file.')).ok).toBe(true)
  })
  test('agentop run footer `exit 0` is valid', () => {
    expect(validateTestLog(enc('...output...\nagentop run: exit 0\n')).ok).toBe(true)
  })
  test('NEG: 3 fail (forged-evidence row in §3.5.9)', () => {
    const r = validateTestLog(enc(' 9 pass\n 3 fail\n'))
    expect(r.ok).toBe(false); if (!r.ok) expect(r.rule).toBe('test-log-has-failures')
  })
  test('NEG: 0 pass / no summary / non-zero exit', () => {
    expect(validateTestLog(enc(' 0 pass\n 0 fail\n')).ok).toBe(false)
    expect(validateTestLog(enc('compiling...\ndone\n')).ok).toBe(false)
    expect(validateTestLog(enc('agentop run: exit 1\n')).ok).toBe(false)
  })
  test('NEG: a passing summary with a non-zero agentop footer is refused', () => {
    const r = validateTestLog(enc(' 5 pass\n 0 fail\nagentop run: exit 1\n'))
    expect(r.ok).toBe(false); if (!r.ok) expect(r.rule).toBe('test-log-nonzero-exit')
  })
  test('NEG: an `exit 0` footer cannot launder a failing summary', () => {
    expect(validateTestLog(enc(' 5 pass\n 2 fail\nagentop run: exit 0\n')).ok).toBe(false)
  })
})

describe('§3.1 report', () => {
  const body = (verdictLine: string) => '# Findings\n' + 'The measurement is described in detail here. '.repeat(10) + '\n' + verdictLine + '\n'
  test('markdown ≥ 300 B with a Verdict/Veredito/Result/Resultado line', () => {
    for (const w of ['Verdict', 'Veredito', 'Result', 'Resultado']) expect(validateReport({ bytes: enc(body(`${w}: ok`)) }).ok).toBe(true)
  })
  test('NEG: no verdict line (§3.5.9)', () => {
    const r = validateReport({ bytes: enc(body('nothing to see')) })
    expect(r.ok).toBe(false); if (!r.ok) expect(r.rule).toBe('report-no-verdict')
  })
  test('NEG: verdict word mid-line is not a verdict line', () => {
    expect(validateReport({ bytes: enc(body('see the Verdict: ok')) }).ok).toBe(false)
  })
  test('NEG: under 300 bytes', () => {
    const r = validateReport({ bytes: enc('Verdict: ok\n') })
    expect(r.ok).toBe(false); if (!r.ok) expect(r.rule).toBe('report-too-small')
  })
  test('repoRef: valid only when the file exists and the sha is reachable from a remote branch', () => {
    const ref = { repo: 'github.com/o/r', sha: 'a'.repeat(40), path: 'docs/x.md' }
    expect(validateReport({ repoRef: ref, facts: { exists: true, reachableFromRemote: true } }).ok).toBe(true)
  })
  test('NEG: unpushed repoRef / missing path / no facts (§3.5.9)', () => {
    const ref = { repo: 'github.com/o/r', sha: 'a'.repeat(40), path: 'docs/x.md' }
    const r = validateReport({ repoRef: ref, facts: { exists: true, reachableFromRemote: false } })
    expect(r.ok).toBe(false); if (!r.ok) expect(r.rule).toBe('report-ref-unpushed')
    expect(validateReport({ repoRef: ref, facts: { exists: false, reachableFromRemote: true } }).ok).toBe(false)
    expect(validateReport({ repoRef: ref }).ok).toBe(false)
  })
  test('NEG: malformed repoRef (short sha, traversal path)', () => {
    const f = { exists: true, reachableFromRemote: true }
    expect(validateReport({ repoRef: { repo: 'r', sha: 'abc', path: 'a.md' }, facts: f }).ok).toBe(false)
    expect(validateReport({ repoRef: { repo: 'r', sha: 'a'.repeat(40), path: '../etc/passwd' }, facts: f }).ok).toBe(false)
  })
})

describe('§4.5 Probe shapes — attach-time validation, no runtime', () => {
  const noItems: EvidenceItem[] = []
  const http: Probe = { kind: 'http', path: '/api/version', expect: { status: 200, pointer: '/version', exists: true } }
  test('the closed set is exactly http | bundle | cli | structural', () => {
    expect([...PROBE_KINDS].sort()).toEqual(['bundle', 'cli', 'http', 'structural'])
  })
  test('well-formed probes of each kind are valid', () => {
    expect(validateProbe(http, { headSha: 'h', items: noItems }).ok).toBe(true)
    expect(validateProbe({ kind: 'bundle', literal: 'a-literal-of-12+' }, { headSha: 'h', items: noItems }).ok).toBe(true)
    expect(validateProbe({ kind: 'cli', argv: [...READONLY_CLI_VERBS[0]!], expect: { exit: 0 } }, { headSha: 'h', items: noItems }).ok).toBe(true)
  })
  test('NEG http: path outside /api/, traversal, absolute URL, non-integer status, bad regex', () => {
    const c = { headSha: 'h', items: noItems }
    for (const path of ['/etc/passwd', 'http://x/api/a', '/api/../x', 'api/x', '/api/a b']) {
      const r = validateProbe({ kind: 'http', path, expect: { status: 200 } }, c)
      expect(r.ok, path).toBe(false)
    }
    expect(validateProbe({ kind: 'http', path: '/api/x', expect: { status: 200.5 } }, c).ok).toBe(false)
    expect(validateProbe({ kind: 'http', path: '/api/x', expect: { status: 99 } }, c).ok).toBe(false)
    expect(validateProbe({ kind: 'http', path: '/api/x', expect: { status: 200, matches: '(' } }, c).ok).toBe(false)
    expect(validateProbe({ kind: 'http', path: '/api/x', expect: { status: 200, pointer: 'nope' } }, c).ok).toBe(false)
  })
  test('NEG bundle: literal under 12 chars', () => {
    const r = validateProbe({ kind: 'bundle', literal: 'short' }, { headSha: 'h', items: noItems })
    expect(r.ok).toBe(false); if (!r.ok) expect(r.rule).toBe('probe-bundle-literal-short')
  })
  test('NEG cli: verb outside the read-only allowlist, shell metacharacters, empty argv', () => {
    const c = { headSha: 'h', items: noItems }
    expect(validateProbe({ kind: 'cli', argv: ['session', 'kill', 'x'], expect: { exit: 0 } }, c).ok).toBe(false)
    expect(validateProbe({ kind: 'cli', argv: [...READONLY_CLI_VERBS[0]!, ';rm -rf /'], expect: { exit: 0 } }, c).ok).toBe(false)
    expect(validateProbe({ kind: 'cli', argv: [], expect: { exit: 0 } }, c).ok).toBe(false)
  })
  test('NEG unknown kind / not an object', () => {
    expect(validateProbe({ kind: 'shell', cmd: 'x' } as never, { headSha: 'h', items: noItems }).ok).toBe(false)
    expect(validateProbe(null as never, { headSha: 'h', items: noItems }).ok).toBe(false)
  })
  describe('structural', () => {
    const log = (over: Partial<EvidenceItem> = {}): EvidenceItem => ({
      id: 'ev-aaaaaaaaaaaa', kind: 'test-log', sha256: 'x', revision: 1, headSha: 'h1', treeClean: true, by: 's', at: 't', ...over,
    })
    const s = (over: Partial<Extract<Probe, { kind: 'structural' }>> = {}): Probe =>
      ({ kind: 'structural', reason: 'a refactor with no observable read-only surface', testLogId: 'ev-aaaaaaaaaaaa', ...over })
    test('valid with a test-log evidence at the piece HEAD', () => {
      expect(validateProbe(s(), { headSha: 'h1', items: [log()] }).ok).toBe(true)
    })
    test('NEG: reason empty/too short', () => {
      expect(validateProbe(s({ reason: ' ' }), { headSha: 'h1', items: [log()] }).ok).toBe(false)
    })
    test('NEG: testLogId unknown, of another kind, or at another HEAD', () => {
      expect(validateProbe(s({ testLogId: 'ev-bbbbbbbbbbbb' }), { headSha: 'h1', items: [log()] }).ok).toBe(false)
      expect(validateProbe(s(), { headSha: 'h1', items: [log({ kind: 'report' })] }).ok).toBe(false)
      const r = validateProbe(s(), { headSha: 'h2', items: [log()] })
      expect(r.ok).toBe(false); if (!r.ok) expect(r.rule).toBe('probe-structural-testlog-stale')
    })
  })
  test('canonical probe JSON is key-order independent and the sha256 is of it', () => {
    const a: Probe = { kind: 'http', path: '/api/x', expect: { status: 200, pointer: '/a' } }
    const b = { expect: { pointer: '/a', status: 200 }, path: '/api/x', kind: 'http' } as Probe
    expect(canonicalProbeJson(a)).toBe(canonicalProbeJson(b))
    expect(sha256Hex(enc(canonicalProbeJson(a)))).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('buildEvidenceItem — attach-time composition', () => {
  const ctx = { revision: 2, headSha: 'h1' as string | null, treeClean: true, by: 'session:abc', at: '2026-11-13T10:00:00Z', items: [] as EvidenceItem[] }
  test('a valid screenshot becomes an item with server-computed sha256, revision, headSha, dims', () => {
    const bytes = png(1280, 800)
    const r = buildEvidenceItem({ kind: 'screenshot', fileId: 'f1', bytes }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.item.id).toMatch(/^ev-[0-9a-f]{12}$/)
      expect(r.item).toMatchObject({ kind: 'screenshot', fileId: 'f1', sha256: sha256Hex(bytes), revision: 2, headSha: 'h1', treeClean: true, width: 1280, height: 800, by: 'session:abc', at: ctx.at })
    }
  })
  test('a probe item hashes the canonical JSON and carries the probe', () => {
    const probe: Probe = { kind: 'bundle', literal: 'a-literal-of-12+' }
    const r = buildEvidenceItem({ kind: 'probe', probe }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.item.probe).toEqual(probe); expect(r.item.sha256).toBe(sha256Hex(enc(canonicalProbeJson(probe)))) }
  })
  test('NEG: an invalid payload is refused evidence_invalid naming the rule', () => {
    const r = buildEvidenceItem({ kind: 'screenshot', fileId: 'f1', bytes: png(1, 1) }, ctx)
    expect(r.ok).toBe(false); if (!r.ok) { expect(r.code).toBe('evidence_invalid'); expect(r.rule).toBe('screenshot-too-small-dimensions') }
  })
  test('NEG: unknown kind and missing payload', () => {
    expect(buildEvidenceItem({ kind: 'video' as never }, ctx).ok).toBe(false)
    expect(buildEvidenceItem({ kind: 'screenshot' } as never, ctx).ok).toBe(false)
  })
  test('the item never takes a caller-supplied time or hash', () => {
    const r = buildEvidenceItem({ kind: 'screenshot', fileId: 'f', bytes: png(1280, 800), sha256: 'forged', at: '1999' } as never, ctx)
    expect(r.ok).toBe(true); if (r.ok) { expect(r.item.sha256).not.toBe('forged'); expect(r.item.at).toBe(ctx.at) }
  })
  test('reuse is enforced inside the composition (same bytes already on another piece)', () => {
    const bytes = png(1280, 800)
    const first = buildEvidenceItem({ kind: 'screenshot', fileId: 'f', bytes }, ctx)
    if (!first.ok) throw new Error('setup')
    const r = buildEvidenceItem({ kind: 'screenshot', fileId: 'g', bytes }, { ...ctx, items: [], reuseIndex: [{ sha256: first.item.sha256, pieceKey: 'other', revision: 1 }], pieceKey: 'mine' })
    expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe('evidence_reused')
  })
})

describe('§3.1 unique forever / §3.5.11 reuse', () => {
  const idx = [{ sha256: 'aa', pieceKey: 'p1', revision: 1 }]
  test('same bytes on a second piece → evidence_reused naming the other piece/revision', () => {
    const r = checkReuse(idx, { sha256: 'aa', pieceKey: 'p2', revision: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.code).toBe('evidence_reused'); expect(r.message).toContain('p1'); expect(r.message).toContain('1') }
  })
  test('same bytes re-attached to the SAME piece at a later revision (after ajuste) → evidence_reused', () => {
    const r = checkReuse(idx, { sha256: 'aa', pieceKey: 'p1', revision: 2 })
    expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe('evidence_reused')
  })
  test('different bytes are fine, on any piece or revision', () => {
    expect(checkReuse(idx, { sha256: 'bb', pieceKey: 'p1', revision: 2 }).ok).toBe(true)
  })
  test('the very same item (same piece, same revision) is an idempotent re-add, not a reuse', () => {
    const r = checkReuse(idx, { sha256: 'aa', pieceKey: 'p1', revision: 1 })
    expect(r).toEqual({ ok: true, duplicate: true })
  })
  test('a removed item frees nothing: the index is the caller\'s history, never pruned here', () => {
    expect(checkReuse([...idx], { sha256: 'aa', pieceKey: 'p3', revision: 9 }).ok).toBe(false)
  })
})
