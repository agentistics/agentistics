import { describe, expect, test } from 'bun:test'
import { bisectFirst, findEnginePinTag, hintsFromHandbacks, hintsFromText, hydrateProofCache, loadBatchPrs, matchBatchPr, meterFacts, newProofCache, serializeProofCache, textNamesBranch, textNamesSha, titleCode, type BatchPr } from './batch-proof'
import type { GateFacts } from './gates'

const pr = (n: number, body: string, over: Partial<BatchPr> = {}): BatchPr => ({ repo: 'agentistics/agentistics', number: n, title: `release PR ${n}`, body, mergeSha: `merge${n}`.padEnd(40, '0'), ...over })
const piece = (over: Partial<Parameters<typeof matchBatchPr>[1]> = {}) => ({ subtaskId: 's-8728082f37', branches: [], shas: [], ...over })
/** A commit, and a piece whose delivery declared it. */
const HEAD = '2c06a8b56c0ffee0000000000000000000000000'
const own = piece({ heads: [{ branch: 'fix/x', sha: '2c06a8b56' }] })
const carrying = (n: number, over: Partial<BatchPr> = {}) => pr(n, '', { commits: [HEAD], ...over })

describe('matchBatchPr — which merged release PR lists a piece', () => {
  test('the subtask id in a PR\'s text is a SUGGESTION, never proof (leader, 08/11); a proven PR\'s merge commit is its own', () => {
    const named = matchBatchPr([pr(1, 'unrelated'), pr(1329, 'fixes s-8728082f37 and more')], piece())
    expect(named.ok).toBe(false)
    expect(!named.ok && named.suggestion?.pr.number).toBe(1329)
    const r = matchBatchPr([pr(1, 'unrelated'), pr(1329, '', { commits: [HEAD] })], own)
    expect(r.ok && r.pr.number).toBe(1329)
    expect(r.ok && r.pr.mergeSha).toBe('merge1329'.padEnd(40, '0'))
    expect(r.ok && r.via).toContain('fix/x @ 2c06a8b56')
  })
  test('a branch named in a PR\'s text is a SUGGESTION, never proof; a longer branch is not even that', () => {
    const body = 'external Codex sessions (fix/externas-tocar-codex) and (fix/metricas-soma, fix/opencode-metricas-v2)'
    const named = matchBatchPr([pr(1329, body)], piece({ branches: ['fix/metricas-soma'] }))
    expect(named.ok).toBe(false)
    expect(!named.ok && named.suggestion?.pr.number).toBe(1329)
    const longer = matchBatchPr([pr(1329, 'fix/metricas-soma-v2 only')], piece({ branches: ['fix/metricas-soma'] }))
    expect(!longer.ok && longer.suggestion).toBeUndefined()
    expect(textNamesBranch('x f/ab', 'f/ab')).toBe(false) // too short to be a name
    expect(textNamesBranch('x main', 'main')).toBe(false) // no namespace: a word, not a branch
  })
  test('a declared commit proves a PR only when it is one of the PR\'s OWN commits (a short one resolves to a full one); text quoting it proves nothing', () => {
    const full = '2c06a8b56c0ffee0000000000000000000000000'
    expect(matchBatchPr([pr(5, 'no mention', { commits: [full] })], piece({ heads: [{ branch: 'fix/x', sha: '2c06a8b56' }] })).ok).toBe(true)
    expect(matchBatchPr([pr(5, 'no mention', { commits: [full] })], piece({ shas: [full] })).ok).toBe(true)
    expect(matchBatchPr([pr(5, 'commits: 2c06a8b56 and deadbeef1')], piece({ heads: [{ branch: 'fix/x', sha: '2c06a8b56' }] })).ok).toBe(false)
    expect(matchBatchPr([pr(5, `pinned at ${full}`)], piece({ shas: [full] })).ok).toBe(true) // the full sha, stated in the PR itself
    expect(textNamesSha('only 2c06a8b56', [full])).toBe(false) // a prefix is not the commit
    expect(textNamesSha('deadbeef', ['0123456789abcdef'])).toBe(false)
  })
  test('the PR of the declared branch proves it only when merged AFTER that declaration (an older round of the branch does not)', () => {
    const at = Date.parse('2026-11-06T12:00:00Z')
    const head = { headRefName: 'feat/x', mergedAt: '2026-11-07T00:00:00Z' }
    expect(matchBatchPr([pr(5, '', head)], piece({ heads: [{ branch: 'feat/x', sha: 'abc1234', atMs: at }] })).ok).toBe(true)
    expect(matchBatchPr([pr(5, '', { ...head, mergedAt: '2026-11-05T00:00:00Z' })], piece({ heads: [{ branch: 'feat/x', sha: 'abc1234', atMs: at }] })).ok).toBe(false)
  })
  test('a PR number the delivery states proves it, unless two of the card\'s repositories have that number', () => {
    expect(matchBatchPr([pr(10, 'x', { repo: 'a/engine' })], piece({ prs: [10] })).ok).toBe(true)
    expect(matchBatchPr([pr(10, 'x', { repo: 'a/engine' }), pr(10, 'y', { repo: 'a/public', mergeSha: 'other'.padEnd(40, '0') })], piece({ prs: [10] })).ok).toBe(false)
    expect(matchBatchPr([pr(10, 'x', { repo: 'old/name' }), pr(10, 'x', { repo: 'new/name' })], piece({ prs: [10] })).ok).toBe(true) // one merge under two names of a renamed repository
  })
  test('H4: only PRs of the card\'s own repositories count, whatever they say', () => {
    expect(matchBatchPr([carrying(5)], { ...own, repos: ['acme/shop'] }).ok).toBe(false)
    expect(matchBatchPr([carrying(5, { repo: 'acme/shop' })], { ...own, repos: ['acme/shop'] }).ok).toBe(true)
    expect(matchBatchPr([carrying(5)], { ...own, repos: [] }).ok).toBe(false)
  })
  test('M3: a PR into dev never proves anything; a PR merged before the card existed cannot have shipped it', () => {
    expect(matchBatchPr([carrying(5, { baseRefName: 'dev' })], own).ok).toBe(false)
    expect(matchBatchPr([carrying(5, { baseRefName: 'main' })], own).ok).toBe(true)
    expect(matchBatchPr([carrying(5, { mergedAt: '2026-10-01T00:00:00Z' })], { ...own, createdMs: Date.parse('2026-11-01T00:00:00Z') }).ok).toBe(false)
  })
  test('a line saying the piece was left out is not even a suggestion, in any language it was written', () => {
    const portuguese = matchBatchPr([pr(5, 'Fica para o próximo lote: s-8728082f37')], piece())
    expect(!portuguese.ok && portuguese.suggestion).toBeUndefined()
    const english = matchBatchPr([pr(5, 's-8728082f37 (not included here)\nother line')], piece())
    expect(!english.ok && english.suggestion).toBeUndefined()
  })
  test('two different PRs carrying the declared commit are AMBIGUOUS — nothing is proven, they stay as candidates', () => {
    const r = matchBatchPr([carrying(1), carrying(2)], own)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.ambiguous).toBe(true)
    expect(!r.ok && r.candidates?.map(c => c.number)).toEqual([1, 2])
  })
  test('a tie at one tier is narrowed by another tier\'s evidence', () => {
    const narrowed = matchBatchPr([carrying(1), carrying(2)], { ...own, prs: [2] })
    expect(narrowed.ok && narrowed.pr.number).toBe(2)
  })
  test('the same PR seen twice (two lists) is one candidate, not an ambiguity', () => {
    expect(matchBatchPr([carrying(9), carrying(9)], own).ok).toBe(true)
  })
  test('no PR names it → not proven, with the reason', () => {
    const r = matchBatchPr([pr(1, 'nothing here')], piece())
    expect(!r.ok && r.reason).toContain('no merged release PR proves')
  })
  test('a PR with no merge commit never counts', () => {
    expect(matchBatchPr([{ ...carrying(1), mergeSha: '' }], own).ok).toBe(false)
  })
  test('the card\'s CODE.NAME never moves anything: it becomes a suggestion, as a whole word', () => {
    expect(titleCode('METRICAS.SOMA — fix totals')).toBe('METRICAS.SOMA')
    expect(titleCode('Implement and validate x')).toBeNull()
    const named = matchBatchPr([pr(7, 'ElevenLabs voices (JARVIS.ELEVEN-VOZES)')], piece({ title: 'JARVIS.ELEVEN-VOZES' }))
    expect(named.ok).toBe(false)
    expect(!named.ok && named.suggestion?.pr.number).toBe(7)
    const left = matchBatchPr([pr(7, 'Fica para o próximo lote: LIVE.ATALHO')], piece({ title: 'LIVE.ATALHO' }))
    expect(!left.ok && left.suggestion).toBeUndefined()
  })
  test('what a delivery statement declares: a branch WITH its commit, a full sha, a PR number; nothing else on the line is read', () => {
    const h = hintsFromText('Ramo fix/voz-bugs-2 @ 422bb0c0, push OK. PR #1343 verde. decadeface is a word; see docs/plan-limits.md and feat/mentioned')
    expect(h.heads).toEqual([{ branch: 'fix/voz-bugs-2', sha: '422bb0c0' }])
    expect(h.branches).toEqual(['fix/voz-bugs-2'])
    expect(h.prs).toEqual([1343])
    expect(h.shas).toEqual([])
    expect(hintsFromText('feat/run-rm-test-foundation 7ef51fa1 (push ok)').heads[0]).toEqual({ branch: 'feat/run-rm-test-foundation', sha: '7ef51fa1' })
    expect(hintsFromText('Ramo fix/x, commit cb04dfe5, sem PR').heads[0]).toEqual({ branch: 'fix/x', sha: 'cb04dfe5' })
    expect(hintsFromText('commit 092a27f5fd pushed to perf/live-delivery (ok)').heads[0]).toEqual({ branch: 'perf/live-delivery', sha: '092a27f5fd' })
    expect(hintsFromText(`delivered in ${'ab12'.repeat(10)}`).shas).toEqual(['ab12'.repeat(10)])
    expect(hintsFromText(`based on ${'ab12'.repeat(10)}`).shas).toEqual([])
    expect(hintsFromText('depends on PR #12').prs).toEqual([])
  })
  test('QA r2 M-1: a base sha is not the delivery however far it sits from the keyword', () => {
    const sha = 'ab12'.repeat(10)
    expect(hintsFromText(`rebased on top of origin/main, the branch was cut from the release that came out last week, base ${sha}`).shas).toEqual([])
    expect(hintsFromText(`Based on the state of the repository as it was before the sweep started, at ${sha}`).shas).toEqual([])
    expect(hintsFromText(`base is the tip of origin/main as of this morning and the work sits on fix/far-away @ 4444444`).heads).toEqual([])
    expect(hintsFromText(`delivered in ${sha}`).shas).toEqual([sha])
  })
  test('QA r2: a line that says the work was left out declares nothing', () => {
    expect(hintsFromText('Fica para o próximo lote: fix/atalho @ 4444444 (not included here)').heads).toEqual([])
    expect(hintsFromText(`not included in this release: ${'ab12'.repeat(10)}`).shas).toEqual([])
    expect(hintsFromText('PR #77 deferred to the next batch').prs).toEqual([])
    expect(hintsFromText('fix/atalho @ 4444444 ok').heads).toHaveLength(1)
  })
  test('QA r2: two different PR numbers on one line are not read, in doubt the person decides', () => {
    expect(hintsFromText('PR #77 (o PR #12 é o do outro grupo)').prs).toEqual([])
    expect(hintsFromText('PR #77 verde, PR #77 mesclado').prs).toEqual([77])
    expect(hintsFromText('PR #77\nPR #78').prs).toEqual([77, 78])
  })
  test('the last statement of a branch is the commit it stood at', () => {
    const h = hintsFromHandbacks([{ body: 'feat/x @ aaaa1111', atMs: 1 }, { body: 'feat/x @ bbbb2222', atMs: 2 }])
    expect(h.heads).toEqual([{ branch: 'feat/x', sha: 'bbbb2222', atMs: 2 }])
    expect(h.latest).toEqual(['bbbb2222'])
  })
  test('an earlier round that shipped does not ship the later one: the PR is only a suggestion', () => {
    const first = 'a'.repeat(39) + '1'
    const last = 'b'.repeat(39) + '2'
    const hints = hintsFromHandbacks([{ body: `commit ${first} pushed` }, { body: `round 2: ${last}` }])
    const stale = matchBatchPr([pr(5, '', { commits: [first] })], piece(hints))
    expect(stale.ok).toBe(false)
    expect(!stale.ok && stale.suggestion?.pr.number).toBe(5)
    expect(matchBatchPr([pr(6, '', { commits: [first, last] })], piece(hints)).ok).toBe(true)
  })
})

describe('the proof cache and the meter — a second run asks nothing, a third of the quota is left alone', () => {
  test('survives JSON: what gh answered comes back, an unknown answer does not', () => {
    const c = newProofCache(100)
    c.contains.set('a...b', true)
    c.contains.set('c...d', null)
    c.localTags.set('sha1', 'v1.2.3')
    c.tags.set('o/r', { list: ['v1.2.3'], shas: new Map([['v1.2.3', 'x']]), complete: true, at: 100 })
    c.commits.set('o/r', { at: 100, byPr: new Map([[7, ['oid']]]) })
    c.outcomes.set('s-1', { proven: true })
    c.auto.nextAt = 500
    const back = hydrateProofCache(JSON.parse(JSON.stringify(serializeProofCache(c))), 200)
    expect(back.contains.get('a...b')).toBe(true)
    expect(back.contains.has('c...d')).toBe(false)
    expect(back.localTags.get('sha1')).toBe('v1.2.3')
    expect(back.tags.get('o/r')?.shas.get('v1.2.3')).toBe('x')
    expect(back.commits.get('o/r')?.byPr.get(7)).toEqual(['oid'])
    expect(back.outcomes.get('s-1')?.proven).toBe(true)
    expect(back.auto.nextAt).toBe(500)
  })
  test('junk on disk is an empty cache, never a throw', () => {
    expect(hydrateProofCache({ version: 1, prs: 'nope' }, 1).prs.size).toBe(0)
    expect(hydrateProofCache(null, 1).prs.size).toBe(0)
  })
  test('the meter stops at the budget and at a rate limit, and every later call fails at once', async () => {
    let real = 0
    const base = { gh: async () => { real++; return 'x' } } as unknown as GateFacts
    const m = meterFacts(base, 2)
    await m.facts.gh('.', ['a']); await m.facts.gh('.', ['b'])
    await expect(m.facts.gh('.', ['c'])).rejects.toThrow('budget')
    expect(m.stopped()).toBe('budget')
    expect(real).toBe(2)
    const limited = meterFacts({ gh: async () => { throw new Error('gh: API rate limit exceeded for user') } } as unknown as GateFacts, 9)
    await expect(limited.facts.gh('.', ['a'])).rejects.toThrow('rate limit')
    expect(limited.stopped()).toBe('rate-limit')
    await expect(limited.facts.gh('.', ['b'])).rejects.toThrow('gh skipped')
    expect(limited.calls()).toBe(1)
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
  test('the swallowed reason is kept (first line, no token) so the entry can say WHY gh was unreadable', async () => {
    const cache = newProofCache()
    const f = { gh: async () => { throw new Error('gh: HTTP 401 with ghp_abcdefghijklmnopqrstuvwxyz0123456789\nsecond line') } } as unknown as GateFacts
    await loadBatchPrs(f, '/r', 'o/r', cache)
    const why = cache.unreadableWhy.get('o/r') ?? ''
    expect(why).toContain('HTTP 401')
    expect(why).not.toContain('ghp_abcdef')
    expect(why).not.toContain('second line')
    // gh answered, but not with a PR list (the shape of the spawn-guard bug: an undefined answer)
    const odd = newProofCache()
    await loadBatchPrs({ gh: async () => undefined } as unknown as GateFacts, '/r', 'o/r', odd)
    expect(odd.unreadableWhy.get('o/r')).toContain('not a PR list')
    // a later good read clears it
    const ok = { gh: async () => '[]' } as unknown as GateFacts
    await loadBatchPrs(ok, '/r', 'o/r', cache)
    expect(cache.unreadableWhy.has('o/r')).toBe(false)
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
