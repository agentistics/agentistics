/** Evidence for pipeline transitions. Caller-supplied push/PR booleans are never proof. */
import { execFile } from 'node:child_process'
import { freemem } from 'node:os'
import { promisify } from 'node:util'
import { gitEnv } from '../backup/repo-probe'

const exec = promisify(execFile)
const refuse = (reason: string, missing: string[]) => ({ refused: true, reason, missing })
const rec = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

export interface PipelineHostDeps {
  session(id: string): Promise<{ cwd: string; worktree: boolean; taskId?: string; subtaskId?: string; role?: string; harness?: string; model?: string; leaderId?: string; successorId?: string; rootPath?: string; ended?: boolean } | null>
  git(cwd: string, args: string[]): Promise<string>
  pr(cwd: string, branch: string): Promise<unknown>
  memory?(): Promise<number | null>
  release?(cwd: string, runId: string): Promise<unknown>
}
export function defaultPipelineHostDeps(): PipelineHostDeps {
  return {
    session: async id => {
      const row = (await (await import('../sessions/registry')).readRegistry()).find(r => r.id === id)
      if (!row) return null
      const { storedRoleFor } = await import('../sessions/session-roles')
      const { currentLeaderId } = await import('../sessions/team-links')
      const registry = await (await import('../sessions/registry')).readRegistry()
      const parent = row.parentSessionId ?? registry.find(r => r.conversationId === row.parentConversationId)?.id
      return { cwd: row.cwd, worktree: row.repo?.worktree === true, rootPath: row.repo?.rootPath, ended: !!row.endedAt, taskId: row.taskId, subtaskId: row.subtaskId, role: await storedRoleFor([row.conversationId, row.id]), harness: row.harness, model: row.model, leaderId: parent ? currentLeaderId(registry, parent) : undefined, successorId: currentLeaderId(registry, row.id) }
    },
    git: async (cwd, args) => (await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { timeout: 15_000, env: gitEnv() })).stdout,
    pr: async (cwd, branch) => JSON.parse((await exec('gh', ['pr', 'view', branch, '--json', 'url,headRefOid,state,mergeable,statusCheckRollup,mergeCommit'], { cwd, timeout: 15_000, env: gitEnv() })).stdout),
    memory: async () => process.platform === 'linux' ? (await import('../cli-run')).memAvailableBytes() : freemem(),
    release: async (cwd, runId) => JSON.parse((await exec('gh', ['api', `repos/{owner}/{repo}/actions/runs/${runId}`], { cwd, timeout: 15_000, env: gitEnv() })).stdout),
  }
}

export function pipelineHostOps(d: PipelineHostDeps = defaultPipelineHostDeps()) {
  const inspect = async (value: unknown, requirePr: boolean) => {
    const i = rec(value)
    if (typeof i.sessionId !== 'string' || !i.sessionId) return refuse('sessionId is required', ['sessionId'])
    try {
      const row = await d.session(i.sessionId)
      if (!row?.worktree) return refuse('delivery requires the session\'s own recorded worktree', ['own worktree'])
      const text = async (args: string[]) => (await d.git(row.cwd, args)).trim()
      const head = await text(['rev-parse', 'HEAD'])
      if (typeof i.head === 'string' && i.head !== head) return refuse('HEAD changed since delivery', ['delivered HEAD'])
      if ((await d.git(row.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length) return refuse('working tree is dirty', ['clean worktree'])
      const branch = await text(['symbolic-ref', '--quiet', '--short', 'HEAD'])
      if (!branch || ['main', 'dev'].includes(branch)) return refuse('a feature branch is required', ['feature branch'])
      const remote = await text(['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`])
      if (remote.split(/\s/)[0] !== head) return refuse('local HEAD is not pushed to origin', ['push matching HEAD'])
      if (!requirePr) return { ok: true, sessionId: i.sessionId, head, branch, pushed: true }
      const pr = rec(await d.pr(row.cwd, branch))
      if (pr.state !== 'OPEN' || pr.headRefOid !== head || typeof pr.url !== 'string' || !pr.url.startsWith('https://')) return refuse('an open PR for the delivered HEAD is required', ['open PR matching HEAD'])
      const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup.map(rec) : []
      const ci = !checks.length ? 'unknown' : checks.every(c => c.conclusion === 'SUCCESS' || c.conclusion === 'SKIPPED' || c.conclusion === 'NEUTRAL' || c.state === 'SUCCESS') ? 'passed' : checks.some(c => ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(String(c.conclusion)) || c.state === 'FAILURE' || c.state === 'ERROR') ? 'failed' : 'pending'
      return { ok: true, sessionId: i.sessionId, head, branch, pushed: true, prUrl: pr.url, ci, mergeable: pr.mergeable === 'MERGEABLE' }
    } catch { return refuse('delivery evidence could not be verified', ['readable worktree, origin and PR evidence']) }
  }
  return {
    'fluxos-alterados': async () => { (await import('../sse')).broadcastFlowsChanged(); return { ok: true } },
    'pipeline-pr-salvo': async (v: unknown) => {
      const i = rec(v)
      if (typeof i.sessionId !== 'string' || typeof i.branch !== 'string' || typeof i.head !== 'string') return refuse('recorded session, branch and HEAD required', ['saved delivery'])
      try {
        const row = await d.session(i.sessionId)
        if (!row?.rootPath) return refuse('parent repository is unknown', ['recorded parent repository'])
        const pr = rec(await d.pr(row.rootPath, i.branch))
        const remote = pr.state === 'MERGED' ? '' : (await d.git(row.rootPath, ['ls-remote', '--exit-code', 'origin', `refs/heads/${i.branch}`])).trim()
        if (pr.headRefOid !== i.head || typeof pr.url !== 'string') return refuse('PR no longer matches the delivered HEAD', ['matching PR'])
        if (pr.state !== 'MERGED' && remote.split(/\s/)[0] !== i.head) return refuse('delivered branch changed on origin', ['matching origin HEAD'])
        const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup.map(rec) : []
        return { ok: true, state: pr.state, head: pr.headRefOid, mergeSha: rec(pr.mergeCommit).oid, prUrl: pr.url, ci: checks.length && checks.every(c => ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(String(c.conclusion)) || c.state === 'SUCCESS') ? 'passed' : 'unknown', mergeable: pr.mergeable === 'MERGEABLE' }
      } catch { return refuse('saved PR evidence unavailable', ['origin and PR evidence']) }
    },
    'pipeline-release': async (v: unknown) => {
      const i = rec(v)
      if (typeof i.sessionId !== 'string' || typeof i.runId !== 'string' || !/^\d+$/.test(i.runId) || typeof i.mergeSha !== 'string') return refuse('release run id and merge SHA required', ['release evidence'])
      try {
        const row = await d.session(i.sessionId)
        if (!row?.rootPath || !d.release) return refuse('release repository unavailable', ['parent repository'])
        const run = rec(await d.release(row.rootPath, i.runId))
        if (run.head_sha !== i.mergeSha || run.path !== '.github/workflows/release.yml' || run.status !== 'completed' || run.conclusion !== 'success') return refuse('release.yml has not passed for the merged SHA', ['green release.yml for merge SHA'])
        return { ok: true, runId: i.runId, mergeSha: i.mergeSha, url: run.html_url }
      } catch { return refuse('release evidence unavailable', ['release run']) }
    },
    'pipeline-sessao': async (v: unknown) => {
      const id = rec(v).sessionId
      if (typeof id !== 'string' || !id) return refuse('sessionId is required', ['sessionId'])
      const row = await d.session(id)
      return row ? { ok: true, sessionId: id, ...row } : refuse('session not found', ['existing session'])
    },
    'pipeline-origem': async (v: unknown) => {
      const id = rec(v).sessionId
      if (typeof id !== 'string') return refuse('sessionId is required', ['sessionId'])
      try {
        const row = await d.session(id)
        if (!row?.worktree) return refuse('own worktree required', ['own worktree'])
        await d.git(row.cwd, ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])
        return { ok: true }
      } catch { return refuse('the worker branch must include origin/main', ['branch from origin/main']) }
    },
    'pipeline-recursos': async () => {
      const { runMinAvailableBytes } = await import('../resources/mem-guard')
      const bytes = await d.memory?.() ?? null
      return bytes !== null && bytes >= runMinAvailableBytes() ? { ok: true, availableBytes: bytes } : refuse('RAM admission failed or is unknown', ['available memory above run minimum'])
    },
    'pipeline-entrega': (v: unknown) => inspect(v, false),
    'pipeline-pr': (v: unknown) => inspect(v, true),
  }
}
