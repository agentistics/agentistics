import { expect, test } from 'bun:test'
import { pipelineHostOps, type PipelineHostDeps } from './pipeline-host'

function fixture() {
  const d: PipelineHostDeps = {
    session: async () => ({ cwd: '/Users/test/work tree', worktree: true }),
    git: async (_cwd, args) => {
      if (args[0] === 'rev-parse') return 'abc123\n'
      if (args[0] === 'status') return ''
      if (args[0] === 'symbolic-ref') return 'feat/pipeline\n'
      if (args[0] === 'ls-remote') return 'abc123\trefs/heads/feat/pipeline\n'
      throw Error('unexpected command')
    },
    pr: async () => ({ url: 'https://github.com/example/repo/pull/1', state: 'OPEN', headRefOid: 'abc123', mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }),
  }
  return d
}

test('delivery proves remote HEAD and PR checks from host evidence', async () => {
  const ops = pipelineHostOps(fixture())
  expect(await ops['pipeline-entrega']({ sessionId: 'worker' })).toMatchObject({ ok: true, pushed: true, head: 'abc123' })
  expect(await ops['pipeline-pr']({ sessionId: 'worker', head: 'abc123' })).toMatchObject({ ok: true, ci: 'passed', mergeable: true })
})

test('dirty, unpushed, shared, moved HEAD and unavailable evidence refuse even when caller claims success', async () => {
  for (const failure of ['dirty', 'unpushed', 'shared', 'changed', 'unavailable']) {
    const d = fixture(), git = d.git
    if (failure === 'shared') d.session = async () => ({ cwd: '/Users/test/shared', worktree: false })
    d.git = async (cwd, args) => {
      if (failure === 'unavailable') throw Error('offline')
      if (failure === 'dirty' && args[0] === 'status') return '?? file\0'
      if (failure === 'unpushed' && args[0] === 'ls-remote') return 'older\trefs/heads/feat/pipeline'
      return git(cwd, args)
    }
    expect(await pipelineHostOps(d)['pipeline-entrega']({ sessionId: 'worker', head: failure === 'changed' ? 'older' : 'abc123', pushed: true })).toMatchObject({ refused: true })
  }
})

test('cleanup PR gate refuses absent, closed or stale PR; reports CI failure/conflict without inventing green', async () => {
  const d = fixture()
  for (const pr of [{}, { state: 'CLOSED' }, { state: 'OPEN', headRefOid: 'older' }]) {
    d.pr = async () => pr
    expect(await pipelineHostOps(d)['pipeline-pr']({ sessionId: 'worker', prUrl: 'https://claimed' })).toMatchObject({ refused: true })
  }
  d.pr = async () => ({ state: 'OPEN', headRefOid: 'abc123', url: 'https://github.com/example/repo/pull/1', mergeable: 'CONFLICTING', statusCheckRollup: [{ conclusion: 'FAILURE' }] })
  expect(await pipelineHostOps(d)['pipeline-pr']({ sessionId: 'worker' })).toMatchObject({ ok: true, ci: 'failed', mergeable: false })
  d.pr = async () => ({ state: 'OPEN', headRefOid: 'abc123', url: 'https://github.com/example/repo/pull/1', statusCheckRollup: [] })
  expect(await pipelineHostOps(d)['pipeline-pr']({ sessionId: 'worker' })).toMatchObject({ ci: 'unknown', mergeable: false })
})

test('saved PR and release checks survive removed worktree and verify actual merged SHA', async () => {
  const d = fixture()
  d.session = async () => ({ cwd: '/Users/test/removed', rootPath: '/Users/test/repo', worktree: true, ended: true })
  d.pr = async () => ({ state: 'MERGED', headRefOid: 'abc123', url: 'https://github.com/example/repo/pull/1', mergeCommit: { oid: 'merge1' } })
  expect(await pipelineHostOps(d)['pipeline-pr-salvo']({ sessionId: 'worker', branch: 'feat/pipeline', head: 'abc123' })).toMatchObject({ ok: true, state: 'MERGED', mergeSha: 'merge1' })
  d.release = async () => ({ head_sha: 'merge1', path: '.github/workflows/release.yml', status: 'completed', conclusion: 'success' })
  expect(await pipelineHostOps(d)['pipeline-release']({ sessionId: 'worker', runId: '123', mergeSha: 'merge1' })).toMatchObject({ ok: true })
  expect(await pipelineHostOps(d)['pipeline-release']({ sessionId: 'worker', runId: '123', mergeSha: 'wrong' })).toMatchObject({ refused: true })
  expect(await pipelineHostOps(d)['pipeline-release']({ sessionId: 'worker', runId: '../other', mergeSha: 'merge1' })).toMatchObject({ refused: true })
})

test('portable memory admission refuses unknown/low readings and admits measured headroom', async () => {
  const d = fixture()
  d.memory = async () => null
  expect(await pipelineHostOps(d)['pipeline-recursos']()).toMatchObject({ refused: true })
  d.memory = async () => 1
  expect(await pipelineHostOps(d)['pipeline-recursos']()).toMatchObject({ refused: true })
  d.memory = async () => Number.MAX_SAFE_INTEGER
  expect(await pipelineHostOps(d)['pipeline-recursos']()).toMatchObject({ ok: true })
})
