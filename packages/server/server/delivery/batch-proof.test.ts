import { describe, expect, test } from 'bun:test'
import { bisectFirst, findEnginePinTag, hintsFromText, loadBatchPrs, matchBatchPr, newProofCache, textNamesBranch, textNamesSha, titleCode, type BatchPr } from './batch-proof'
import type { GateFacts } from './gates'

const pr = (n: number, body: string, over: Partial<BatchPr> = {}): BatchPr => ({ repo: 'agentistics/agentistics', number: n, title: `release PR ${n}`, body, mergeSha: `merge${n}`.padEnd(40, '0'), ...over })
const piece = (over: Partial<Parameters<typeof matchBatchPr>[1]> = {}) => ({ subtaskId: 's-8728082f37', branches: [], shas: [], ...over })

describe('matchBatchPr — which merged release PR lists a piece', () => {
  test('the subtask id in the body names the PR; the merge commit is the PR\'s own', () => {
    const r = matchBatchPr([pr(1, 'unrelated'), pr(1329, 'fixes s-8728082f37 and more')], piece())
    expect(r.ok && r.pr.number).toBe(1329)
    expect(r.ok && r.pr.mergeSha).toBe('merge1329'.padEnd(40, '0'))
  })
  test('the branch name as a whole token names it (a longer branch does not)', () => {
    const body = 'external Codex sessions (fix/externas-tocar-codex) and (fix/metricas-soma, fix/opencode-metricas-v2)'
    expect(matchBatchPr([pr(1329, body)], piece({ branches: ['fix/metricas-soma'] })).ok).toBe(true)
    expect(matchBatchPr([pr(1329, 'fix/metricas-soma-v2 only')], piece({ branches: ['fix/metricas-soma'] })).ok).toBe(false)
    expect(textNamesBranch('x f/ab', 'f/ab')).toBe(false) // too short to be a name
    expect(textNamesBranch('x main', 'main')).toBe(false) // no namespace: a word, not a branch
  })
  test('a commit sha (a prefix either way, ≥7 chars) names it', () => {
    expect(matchBatchPr([pr(5, 'commits: 2c06a8b56 and deadbeef1')], piece({ shas: ['2c06a8b56c0ffee0000000000000000000000000'] })).ok).toBe(true)
    expect(textNamesSha('only abcdef', ['abcdef0123456'])).toBe(false) // 6 chars is not a sha
    expect(textNamesSha('deadbeef', ['0123456789abcdef'])).toBe(false) // a different commit
  })
  test('two different PRs naming the piece are AMBIGUOUS — nothing is proven', () => {
    const r = matchBatchPr([pr(1, 'lists s-8728082f37'), pr(2, 'also lists s-8728082f37')], piece())
    expect(r.ok).toBe(false)
    expect(!r.ok && r.ambiguous).toBe(true)
  })
  test('a tie at one tier is narrowed by another tier\'s evidence; a tie that stays carries its candidates', () => {
    const narrowed = matchBatchPr([pr(1, 'lists fix/metricas-soma'), pr(2, 'lists fix/metricas-soma and s-8728082f37')], piece({ branches: ['fix/metricas-soma'] }))
    expect(narrowed.ok && narrowed.pr.number).toBe(2)
    const tie = matchBatchPr([pr(1, 'lists s-8728082f37'), pr(2, 'lists s-8728082f37')], piece())
    expect(!tie.ok && tie.candidates?.map(c => c.number)).toEqual([1, 2])
  })
  test('the same PR seen twice (two lists) is one candidate, not an ambiguity', () => {
    expect(matchBatchPr([pr(9, 'has s-8728082f37'), pr(9, 'has s-8728082f37')], piece()).ok).toBe(true)
  })
  test('a unique id hit wins over a looser branch hit in another PR', () => {
    const r = matchBatchPr([pr(1, 'fix/metricas-soma'), pr(2, 's-8728082f37')], piece({ branches: ['fix/metricas-soma'] }))
    expect(r.ok && r.pr.number).toBe(2)
  })
  test('no PR names it → not proven, with the reason', () => {
    const r = matchBatchPr([pr(1, 'nothing here')], piece())
    expect(!r.ok && r.reason).toContain('no merged release PR names')
  })
  test('a PR with no merge commit never counts', () => {
    expect(matchBatchPr([{ ...pr(1, 's-8728082f37'), mergeSha: '' }], piece()).ok).toBe(false)
  })
  test('the card\'s CODE.NAME is the last resort', () => {
    expect(titleCode('METRICAS.SOMA — fix totals')).toBe('METRICAS.SOMA')
    expect(titleCode('Implement and validate x')).toBeNull()
    expect(matchBatchPr([pr(7, 'ElevenLabs voices (JARVIS.ELEVEN-VOZES)')], piece({ title: 'JARVIS.ELEVEN-VOZES' })).ok).toBe(true)
  })
  test('hints are read from free text: branches and shas with a digit', () => {
    const h = hintsFromText('PR #1343 verde → squash 957b63e07; ramo feat/live-atalho. decadeface is a word')
    expect(h.shas).toContain('957b63e07')
    expect(h.shas).not.toContain('decadeface')
    expect(h.branches).toContain('feat/live-atalho')
  })
})

describe('bisectFirst — the first release containing a commit in O(log n) look-ups', () => {
  const tags = ['v5', 'v4', 'v3', 'v2', 'v1']
  const run = async (containing: number) => { let calls = 0; const r = await bisectFirst(tags, async t => { calls++; return tags.indexOf(t) < containing }); return { r, calls } }
  test('finds the oldest containing tag', async () => {
    expect((await run(5)).r).toBe(4)
    expect((await run(3)).r).toBe(2)
    expect((await run(1)).r).toBe(0)
  })
  test('nothing contains it yet → null; an unreadable answer → null', async () => {
    expect((await run(0)).r).toBeNull()
    expect(await bisectFirst(tags, async () => null)).toBeNull()
  })
  test('uses far fewer look-ups than the tag count on a long list', async () => {
    const many = Array.from({ length: 200 }, (_, i) => `v${i}`)
    let calls = 0
    const idx = await bisectFirst(many, async t => { calls++; return Number(t.slice(1)) < 120 })
    expect(idx).toBe(119)
    expect(calls).toBeLessThan(12)
  })
})

describe('loadBatchPrs / findEnginePinTag — gh, once per run', () => {
  const facts = (handler: (a: string) => string, log: string[] = []): GateFacts => ({
    gh: async (_cwd: string, args: string[]) => { const a = args.join(' '); log.push(a); return handler(a) },
    git: async () => '', repoCwd: async () => '/r',
  } as unknown as GateFacts)
  test('the PR list of a repository is read ONCE per run and carries title, body and the merge commit', async () => {
    const log: string[] = []
    const f = facts(() => JSON.stringify([{ number: 4, title: 't', body: 'b', mergedAt: 'x', mergeCommit: { oid: 'abc' } }, { number: 5, title: 'no merge', mergeCommit: null }]), log)
    const cache = newProofCache()
    const a = await loadBatchPrs(f, '/r', 'o/r', cache)
    const b = await loadBatchPrs(f, '/r', 'o/r', cache)
    expect(a).toEqual(b)
    expect(a.map(p => p.number)).toEqual([4])
    expect(log.length).toBe(1)
    expect(log[0]).toContain('-R o/r')
  })
  test('an unreadable gh (no token) is an empty list, never a throw', async () => {
    const f = { gh: async () => { throw new Error('gh: not logged in') } } as unknown as GateFacts
    expect(await loadBatchPrs(f, '/r', 'o/r', newProofCache())).toEqual([])
  })
  test('the engine commit ships in the FIRST public tag whose engine.pin contains it', async () => {
    const pins: Record<string, string> = { 'v2.200.0': 'aaaaaaa1', 'v2.200.4': 'bbbbbbb2', 'v2.200.5': 'ccccccc3', 'v2.199.0': 'ddddddd0' }
    const contains = new Set(['aaaaaaa1', 'bbbbbbb2', 'ccccccc3']) // the commit is in these pins; not in v2.199.0's
    const f = facts(a => {
      if (a.includes('/tags?')) return JSON.stringify(['v2.199.0', 'v2.200.5', 'v2.200.0', 'vscode-v1.0.0', 'v2.200.4'].map(name => ({ name })))
      const m = /contents\/engine\.pin\?ref=(\S+)/.exec(a)
      if (m) return Buffer.from(JSON.stringify({ ref: pins[m[1]!] })).toString('base64')
      const c = /compare\/\S+\.\.\.(\w+)/.exec(a)
      if (c) return JSON.stringify({ status: contains.has(c[1]!) ? 'ahead' : 'diverged' })
      return '[]'
    })
    expect(await findEnginePinTag(f, '/r', 'e0e0e0e0e0', newProofCache())).toBe('v2.200.0')
  })
  test('an unreadable ancestry answer never guesses a release', async () => {
    const f = facts(a => {
      if (a.includes('/tags?')) return JSON.stringify([{ name: 'v2.200.0' }])
      if (a.includes('contents/engine.pin')) return Buffer.from(JSON.stringify({ ref: 'aaaaaaa1' })).toString('base64')
      return '{}' // compare says nothing
    })
    expect(await findEnginePinTag(f, '/r', 'e0e0e0e0e0', newProofCache())).toBeNull()
  })
})
