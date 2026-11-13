/**
 * S1b — classification (spec §3.2) and the evidence requirement it feeds (§3.1 binding, §3.3 refusals;
 * anti-bypass §3.5 items 9, 10, 12, 13, 14). Pure parts.
 */
import { describe, expect, test } from 'bun:test'
import { canonicalProbeJson, sha256Hex, type EvidenceItem, type Probe } from './evidence'
import { classifyPiece, evaluateEvidence, isDocPath, isScreenPath, type ClassifyFacts } from './classify'

const HEAD = '3f5f21a000000000000000000000000000000000'
const facts = (over: Partial<ClassifyFacts> = {}): ClassifyFacts => ({
  checkout: 'resolved', everHadRepoCwd: true, headSha: HEAD, dirtyPaths: [], diffPaths: ['packages/server/server/x.ts'], ...over,
})

describe('paths', () => {
  test('docs: docs/** and any *.md; screens: web, vscode, tui', () => {
    expect(isDocPath('docs/a/b.png')).toBe(true); expect(isDocPath('README.md')).toBe(true); expect(isDocPath('packages/x/NOTES.md')).toBe(true)
    expect(isDocPath('packages/x/a.ts')).toBe(false); expect(isDocPath('mydocs/a.ts')).toBe(false)
    for (const p of ['packages/web/src/a.tsx', 'packages/vscode/src/a.ts', 'packages/tui/src/a.tsx']) expect(isScreenPath(p), p).toBe(true)
    expect(isScreenPath('packages/webhooks/a.ts')).toBe(false); expect(isScreenPath('packages/server/web.ts')).toBe(false)
  })
})

describe('§3.2 table — every row', () => {
  test('screen: the diff touches web / vscode / tui (even beside other code)', () => {
    const r = classifyPiece(facts({ diffPaths: ['packages/server/server/x.ts', 'packages/web/src/a.tsx'] }))
    expect(r).toMatchObject({ ok: true, category: 'screen', headSha: HEAD })
  })
  test('code: any other non-doc path (server, CLI, MCP, core, build/config, test-only)', () => {
    for (const p of ['packages/server/server/x.ts', 'packages/mcp/a.ts', 'packages/core/src/a.ts', 'package.json', 'packages/server/server/a.test.ts']) {
      expect(classifyPiece(facts({ diffPaths: [p] })), p).toMatchObject({ ok: true, category: 'code' })
    }
  })
  test('docs: only docs/** and *.md', () => {
    expect(classifyPiece(facts({ diffPaths: ['docs/a.md', 'README.md', 'docs/img/x.png'] }))).toMatchObject({ ok: true, category: 'docs' })
  })
  test('none-verified: checkout resolved, clean, diff EMPTY', () => {
    expect(classifyPiece(facts({ diffPaths: [] }))).toMatchObject({ ok: true, category: 'none-verified' })
  })
  test('unknown → classification_required: no checkout, unreadable repository, unresolvable base', () => {
    for (const checkout of ['none', 'unreadable', 'base-unresolved'] as const) {
      const r = classifyPiece(facts({ checkout, headSha: null, diffPaths: [] }))
      expect(r, checkout).toMatchObject({ ok: false, code: 'classification_required' })
    }
  })
  test('unknown is NOT none: an empty diff with an unresolved checkout never reads as none-verified or docs', () => {
    const r = classifyPiece(facts({ checkout: 'none', headSha: null, diffPaths: [] }))
    expect(r.ok).toBe(false)
  })
  test('a piece whose sessions never had a repository cwd gets the non-code path sentence, never docs/none-verified by silence', () => {
    const r = classifyPiece(facts({ checkout: 'none', everHadRepoCwd: false, headSha: null, diffPaths: [] }))
    expect(r).toMatchObject({ ok: false, code: 'classification_required', nonCodeOnly: true })
    if (!r.ok) { expect(r.message).toMatch(/non-code/i); expect(r.messagePt).toMatch(/não é código|fora de código|não-código/i) }
  })
  test('the refusal tells the worker what to do (file the session / declare a non-code outcome)', () => {
    const r = classifyPiece(facts({ checkout: 'none', headSha: null }))
    if (r.ok) throw new Error('setup'); expect(r.message).toMatch(/file the session/i)
  })
})

describe('uncommitted_changes (§3.2, §3.5.12)', () => {
  test('a dirty checkout with non-doc changes is refused whatever the category, naming the paths', () => {
    const r = classifyPiece(facts({ dirtyPaths: ['packages/web/x.tsx'], diffPaths: ['docs/a.md'] }))
    expect(r).toMatchObject({ ok: false, code: 'uncommitted_changes' })
    if (!r.ok) expect(r.paths).toEqual(['packages/web/x.tsx'])
  })
  test('NO-COMMIT ATTACK: an uncommitted web edit with an empty committed diff is uncommitted_changes, never none-verified / research', () => {
    const r = classifyPiece(facts({ dirtyPaths: ['packages/web/x.tsx'], diffPaths: [] }))
    expect(r).toMatchObject({ ok: false, code: 'uncommitted_changes' })
  })
  test('dirty doc-only changes do not block (treeClean means no uncommitted NON-DOC changes)', () => {
    expect(classifyPiece(facts({ dirtyPaths: ['docs/draft.md', 'NOTES.md'], diffPaths: ['packages/server/server/x.ts'] }))).toMatchObject({ ok: true, category: 'code' })
  })
  test('the unresolved-checkout refusal outranks nothing: unknown stays classification_required even if dirty paths were somehow reported', () => {
    expect(classifyPiece(facts({ checkout: 'none', headSha: null, dirtyPaths: ['a.ts'] }))).toMatchObject({ code: 'classification_required' })
  })
})

describe('structural allowance (§3.2 code row)', () => {
  test('test-only and build-only diffs may use a structural probe; mixed product code may not', () => {
    const t = classifyPiece(facts({ diffPaths: ['packages/server/server/a.test.ts', 'packages/core/src/b.test.ts'] }))
    const b = classifyPiece(facts({ diffPaths: ['package.json', 'bun.lock', '.github/workflows/ci.yml', 'tsconfig.json'] }))
    const m = classifyPiece(facts({ diffPaths: ['packages/server/server/a.test.ts', 'packages/server/server/real.ts'] }))
    expect(t).toMatchObject({ ok: true, structuralAllowed: true }); expect(b).toMatchObject({ ok: true, structuralAllowed: true })
    expect(m).toMatchObject({ ok: true, structuralAllowed: false })
  })
})

// ── evidence requirement ─────────────────────────────────────────────────────
let n = 0
const item = (over: Partial<EvidenceItem>): EvidenceItem =>
  ({ id: `ev-${String(++n).padStart(12, '0')}`, kind: 'report', sha256: `h${n}`, revision: 1, headSha: HEAD, treeClean: true, by: 's', at: 't', ...over })
const probe: Probe = { kind: 'bundle', literal: 'a-literal-of-12+' }
const probeItem = (over: Partial<EvidenceItem> = {}, p: Probe = probe) => item({ kind: 'probe', probe: p, sha256: sha256Hex(new TextEncoder().encode(canonicalProbeJson(p))), ...over })
const shot = (width: number, over: Partial<EvidenceItem> = {}) => item({ kind: 'screenshot', width, height: 800, ...over })
const cls = (over: Partial<ClassifyFacts> = {}) => { const c = classifyPiece(facts(over)); if (!c.ok) throw new Error('setup'); return c }

describe('evaluateEvidence — §3.1 binding and §3.5.14 category lie', () => {
  const screen = cls({ diffPaths: ['packages/web/src/a.tsx'] })
  test('positive control: desktop + mobile screenshots + probe at HEAD → ok, ids returned', () => {
    const items = [shot(1280), shot(390), probeItem()]
    const r = evaluateEvidence(screen, items)
    expect(r.ok).toBe(true); if (r.ok) expect(r.ids).toEqual(items.map(i => i.id))
  })
  test('screen diff with only a report → evidence_required naming the screenshots and the probe', () => {
    const r = evaluateEvidence(screen, [item({ kind: 'report' })])
    expect(r).toMatchObject({ ok: false, code: 'evidence_required' })
    if (!r.ok) { expect(r.missing).toEqual(['desktop screenshot (≥ 1000 px wide)', 'mobile screenshot (≤ 500 px wide)', 'probe']); expect(r.message).toMatch(/desktop screenshot/); expect(r.message).toContain('3f5f21a') }
  })
  test('only a desktop screenshot (+probe) → names the MOBILE one', () => {
    const r = evaluateEvidence(screen, [shot(1280), probeItem()])
    expect(r.ok).toBe(false); if (!r.ok) expect(r.missing).toEqual(['mobile screenshot (≤ 500 px wide)'])
  })
  test('a 700 px screenshot is neither desktop nor mobile', () => {
    const r = evaluateEvidence(screen, [shot(700), probeItem()])
    expect(r.ok).toBe(false); if (!r.ok) expect(r.missing).toEqual(['desktop screenshot (≥ 1000 px wide)', 'mobile screenshot (≤ 500 px wide)'])
  })
  test('code needs (api-capture | test-log) + probe; docs and none-verified need a report', () => {
    const code = cls()
    expect(evaluateEvidence(code, [item({ kind: 'test-log' }), probeItem()]).ok).toBe(true)
    expect(evaluateEvidence(code, [item({ kind: 'api-capture' }), probeItem()]).ok).toBe(true)
    const noProbe = evaluateEvidence(code, [item({ kind: 'test-log' })]); expect(noProbe.ok).toBe(false)
    if (!noProbe.ok) expect(noProbe.missing).toEqual(['probe'])
    expect(evaluateEvidence(cls({ diffPaths: ['docs/a.md'] }), [item({ kind: 'report' })]).ok).toBe(true)
    expect(evaluateEvidence(cls({ diffPaths: [] }), [item({ kind: 'report' })]).ok).toBe(true)
    expect(evaluateEvidence(cls({ diffPaths: ['docs/a.md'] }), [item({ kind: 'test-log' })]).ok).toBe(false)
  })
  test('structural probe counts only where the diff allows it', () => {
    const log = item({ kind: 'test-log' })
    const structural = probeItem({}, { kind: 'structural', reason: 'a refactor no read-only probe can observe', testLogId: log.id })
    const testOnly = cls({ diffPaths: ['packages/server/server/a.test.ts'] })
    expect(evaluateEvidence(testOnly, [log, structural]).ok).toBe(true)
    expect(evaluateEvidence(cls(), [log, structural]).ok).toBe(false)
  })
})

describe('evaluateEvidence — stale (§3.5.10) and forged probes', () => {
  const code = cls()
  const OLD = '1111111000000000000000000000000000000000'
  test('valid evidence taken at an OLDER commit → evidence_stale naming both shas', () => {
    const r = evaluateEvidence(code, [item({ kind: 'test-log', headSha: OLD }), probeItem({ headSha: OLD })])
    expect(r).toMatchObject({ ok: false, code: 'evidence_stale' })
    if (!r.ok) { expect(r.message).toContain('1111111'); expect(r.message).toContain('3f5f21a') }
  })
  test('evidence attached while the tree was dirty (treeClean false) is stale too', () => {
    const r = evaluateEvidence(code, [item({ kind: 'test-log', treeClean: false }), probeItem()])
    expect(r).toMatchObject({ ok: false, code: 'evidence_stale' })
  })
  test('nothing attached at all is evidence_required, not stale', () => {
    expect(evaluateEvidence(code, [])).toMatchObject({ ok: false, code: 'evidence_required' })
  })
  test('evidence for ANOTHER revision still counts only by HEAD binding (revision is unique-forever, not freshness)', () => {
    expect(evaluateEvidence(code, [item({ kind: 'test-log', revision: 3 }), probeItem({ revision: 3 })]).ok).toBe(true)
  })
  test('S1a gap: a probe item whose stored hash is not the canonical hash is evidence_invalid (the hash must come from buildEvidenceItem)', () => {
    const r = evaluateEvidence(code, [item({ kind: 'test-log' }), probeItem({ sha256: 'f'.repeat(64) })])
    expect(r).toMatchObject({ ok: false, code: 'evidence_invalid' })
    if (!r.ok) expect((r as { rule?: string }).rule).toBe('probe-hash-mismatch')
  })
  test('S1a gap: a stored probe object carrying an extra field is evidence_invalid', () => {
    const forged = { ...probe, sneaky: true } as unknown as Probe
    const r = evaluateEvidence(code, [item({ kind: 'test-log' }), item({ kind: 'probe', probe: forged, sha256: sha256Hex(new TextEncoder().encode(canonicalProbeJson(forged))) })])
    expect(r).toMatchObject({ ok: false, code: 'evidence_invalid' })
    if (!r.ok) expect((r as { rule?: string }).rule).toBe('probe-extra-field')
  })
})
