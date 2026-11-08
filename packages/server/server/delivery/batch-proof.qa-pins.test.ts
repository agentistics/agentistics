/**
 * QA pins for CICLO.RECONCILE-2 (qa-reconcile-2.md). Each `test.failing` states the CORRECT behaviour and passes while the bug
 * exists: when a fix lands the test "fails", and the fix removes `.failing`. The strings are real ones, from the board and from
 * the merged PRs on 2026-11-08.
 */
import { describe, expect, test } from 'bun:test'
import { hintsFromText, matchBatchPr, titleCode, type BatchPr } from './batch-proof'

/** `QA_PINS_SHOW=1 bun test …` runs them as plain tests, to read each failure. */
const pin = process.env.QA_PINS_SHOW ? test : test.failing
const pr = (number: number, body: string, over: Partial<BatchPr> = {}): BatchPr => ({ repo: 'agentistics/agentistics', number, title: `release ${number}`, body, mergeSha: `${number}`.padEnd(40, 'a'), ...over })
const proves = (comment: string, prs: BatchPr[], over: { title?: string } = {}) => {
  const hints = hintsFromText(comment)
  return matchBatchPr(prs, { subtaskId: 's-9bc3a18560', branches: hints.branches, shas: hints.shas, ...over }).ok
}

describe('QA pins: free text on a card is not evidence of what the card shipped', () => {
  pin('HIGH s-9bc3a18560: a TASK id is not a commit (t-3648b62bee → "sha" 3648b62bee → engine PR #12, 2.167.0, a week before the card existed)', () => {
    expect(hintsFromText('Worker aberto em t-3648b62bee / s-9bc3a18560').shas).toEqual([])
    expect(proves('JARVIS.VOZ-BUGS-2 (t-3648b62bee / s-9bc3a18560) pronto p/ revisão.', [pr(12, 'J-ATIVAR (t-3648b62bee / s-327f4e08fb).')])).toBe(false)
  })
  pin('HIGH: a session id or flow-key is not a commit either', () => {
    expect(hintsFromText('Worker 8cb6c07938 parado.\n<sub>flow-key c0b3e1750445</sub>').shas).toEqual([])
  })
  pin('HIGH s-d8c69c5a70: the commit a card was compared against is not the card\'s commit', () => {
    expect(proves('Revertendo só o código-fonte para aa46670b, os testes novos dão 15 falhas. Ramo fix/voz-resposta-confiavel, commit cb04dfe5, sem PR.', [pr(1342, 'This repins the engine to aa46670b (BUILT_AGAINST_API 1.24.0).')])).toBe(false)
  })
  pin('HIGH s-9ac8505b03: the base a worktree was cut from is not the card\'s commit', () => {
    expect(proves('worktree ~/agentistics-engine/.worktrees/orbe-painel (fix/voz-orbe-painel de origin/main ba88965b)', [pr(1346, 'Engine pinned to ba88965b (#73: typecheck 0).')])).toBe(false)
  })
  pin('HIGH s-64a07f59d3 and 3 others: a file path is not a branch (docs/plan-limits.md)', () => {
    expect(hintsFromText('- docs/plan-limits.md: "Spawning on an account (D3)"').branches).toEqual([])
    expect(proves('- docs/plan-limits.md: usage routes', [pr(1150, 'full audit of the Usage math (`docs/usage-math-audit.md`, `docs/plan-limits.md`)')])).toBe(false)
  })
  pin('HIGH s-335f62309d: the branch a card was BASED on is not the card\'s branch', () => {
    expect(proves('Branch feat/usage-area-cleanup @50c87af3c (pushed; based on fix/usage-history-charts).', [pr(1157, '- fix/usage-history-charts: Usage history persisted — QA r2 PASS')])).toBe(false)
  })
})

describe('QA pins: a card name alone proves nothing', () => {
  pin('MED titleCode keeps the whole code: JARVIS.VOZ-BUGS-2 is not JARVIS.VOZ-BUGS', () => {
    expect(titleCode('JARVIS.VOZ-BUGS-2 — (a) com ElevenLabs configurada')).toBe('JARVIS.VOZ-BUGS-2')
  })
  pin('HIGH a PR about the FIRST round does not ship the second one (MOBILE.BARRA vs "MOBILE.BARRA r3", both code MOBILE.BARRA)', () => {
    expect(matchBatchPr([pr(1157, 'MOBILE.BARRA first cut')], { subtaskId: 's-3820aa7f21', title: 'MOBILE.BARRA r3 · barra em 3 peças', branches: [], shas: [] }).ok).toBe(false)
  })
  pin('HIGH the name as a longer word: UI.MOBILE is not UI.MOBILE-TABLET', () => {
    expect(matchBatchPr([pr(9, 'UI.MOBILE-TABLET package')], { subtaskId: 's-1', title: 'UI.MOBILE · bug', branches: [], shas: [] }).ok).toBe(false)
  })
  pin('HIGH a PR saying the card did NOT ship is read as proof', () => {
    expect(matchBatchPr([pr(9, 'Fica para o próximo lote: LIVE.ATALHO (not included here).')], { subtaskId: 's-1', title: 'LIVE.ATALHO · atalho', branches: [], shas: [] }).ok).toBe(false)
  })
  pin('HIGH a card in somebody else\'s project with an ordinary name or branch is not an agentistics PR', () => {
    // Every user's board is matched against agentistics/agentistics, whatever repository the card is about.
    const hints = hintsFromText('Branch fix/login @abc1234 pushed in acme/shop')
    expect(matchBatchPr([pr(9, 'fix(auth): session cookie', { headRefName: 'fix/login' })], { subtaskId: 's-1', title: 'AUTH.LOGIN', branches: hints.branches, shas: [] }).ok).toBe(false)
  })
})
