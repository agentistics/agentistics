import { describe, expect, test } from 'bun:test'
import { memoRepoResolver, withRepoAttribution } from './repo-attribution'

async function* of<T>(xs: T[]) { for (const x of xs) yield x }
async function all<T>(it: AsyncIterable<T>) { const out: T[] = []; for await (const x of it) out.push(x); return out }

describe('repository attribution on projected facts (backfill item)', () => {
  test('a fact with no repo gets the remote of its project root; a stated repo is kept', async () => {
    const repoOf = async (root: string) => (root === '/p/app' ? 'github.com/org/app' : '')
    const out = await all(withRepoAttribution(of([
      { repo: '', project: '/p/app' },
      { repo: 'gitlab.com/x/y', project: '/p/app' },
      { repo: '', project: '/tmp/scratch' },
      { repo: '', project: '' },
    ]), repoOf))
    expect(out.map(f => f.repo)).toEqual(['github.com/org/app', 'gitlab.com/x/y', '', ''])
  })

  test('each root is resolved once, however many facts and concurrent readers ask', async () => {
    let calls = 0
    const repoOf = memoRepoResolver(async root => { calls++; return root === '/p/app' ? 'github.com/org/app' : undefined })
    const facts = Array.from({ length: 50 }, () => ({ repo: '', project: '/p/app' }))
    await Promise.all([all(withRepoAttribution(of(facts), repoOf)), all(withRepoAttribution(of(facts), repoOf))])
    expect(calls).toBe(1)
    expect(await repoOf('/nowhere')).toBe('')
  })

  test('a resolver that throws attributes nothing, it never fails the read', async () => {
    const repoOf = memoRepoResolver(async () => { throw new Error('git missing') })
    expect((await all(withRepoAttribution(of([{ repo: '', project: '/p' }]), repoOf)))[0]!.repo).toBe('')
  })
})
