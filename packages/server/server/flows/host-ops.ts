import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readRawFleetSnapshot } from '../cli-start'

const run = promisify(execFile)
type Input = Record<string, unknown>
type Refusal = { refused: true; reason: string; missing: string[] }
const refuse = (reason: string, missing: string[] = []): Refusal => ({ refused: true, reason, missing })
const inputOf = (v: unknown): Input => v && typeof v === 'object' ? v as Input : {}
const cwdOf = (v: unknown): string | null => typeof inputOf(v).cwd === 'string' ? inputOf(v).cwd as string : null
const sessionOf = (v: unknown): string | null => {
  const i = inputOf(v)
  return typeof i.sessionId === 'string' ? i.sessionId : typeof i.session === 'string' ? i.session : null
}

const streaks = new Map<string, { at: number; count: number }>()

/** The read-only host operation registry for the v1 built-ins. */
export function flowHostOps() {
  return {
    'sessao-parada': async (value: unknown) => {
      const id = sessionOf(value)
      if (!id) return refuse('session id is required', ['sessionId'])
      const snapshot = await readRawFleetSnapshot()
      const row = snapshot.sessions.find(s => s.id === id)
      if (!row) return refuse('session was not found', ['existing session'])
      if (row.status !== 'running' || row.activity !== 'waiting' || row.background === true) {
        return refuse('session is not confirmed stopped', ['waiting activity on two consecutive polls', 'no background work'])
      }
      const previous = streaks.get(id)
      const count = previous && snapshot.polledAtMs > previous.at ? previous.count + 1 : 1
      streaks.set(id, { at: snapshot.polledAtMs, count })
      return count >= 2 ? { ok: true, sessionId: id, polls: count } : refuse('session is waiting, but needs a second confirmed poll', ['second waiting poll'])
    },
    'arvore-limpa': async (value: unknown) => {
      const cwd = cwdOf(value)
      if (!cwd) return refuse('repository cwd is required', ['cwd'])
      try {
        const { stdout } = await run('git', ['-C', cwd, 'status', '--porcelain'])
        return stdout.trim() ? refuse('working tree is dirty', stdout.trim().split('\n')) : { ok: true, cwd }
      } catch (error) { return refuse(`could not inspect working tree: ${String(error)}`, ['readable git worktree']) }
    },
    'trabalho-salvo': async (value: unknown) => {
      const cwd = cwdOf(value)
      if (!cwd) return refuse('repository cwd is required', ['cwd'])
      try {
        const { stdout: branchOut } = await run('git', ['-C', cwd, 'branch', '--show-current'])
        const branch = branchOut.trim()
        if (!branch) return refuse('current branch could not be determined', ['branch'])
        const { stdout: headOut } = await run('git', ['-C', cwd, 'rev-parse', 'HEAD'])
        const head = headOut.trim()
        const { stdout: remoteOut } = await run('git', ['-C', cwd, 'ls-remote', 'origin', `refs/heads/${branch}`])
        const remote = remoteOut.trim().split(/\s+/)[0]
        return remote === head ? { ok: true, branch, head, evidence: 'ls-remote' } : refuse('local HEAD is not saved on origin', [`push ${branch}`])
      } catch (error) { return refuse(`could not verify remote save: ${String(error)}`, ['reachable origin']) }
    },
    'handback-recebido': async (value: unknown) => {
      const i = inputOf(value)
      return i.handbackReceived === true ? { ok: true } : refuse('no handback was received after the latest commit', ['handback from session to leader'])
    },
    'gravar-veredito': async () => ({ ok: true, readOnly: true }),
    'limpeza-dry-run': async (value: unknown) => {
      const cwd = cwdOf(value) ?? process.cwd()
      try {
        const { stdout } = await run('git', ['-C', cwd, 'worktree', 'list', '--porcelain'])
        const paths = stdout.split(/\n(?=worktree )/).map(x => x.match(/^worktree (.+)$/m)?.[1]).filter((x): x is string => Boolean(x))
        return { ok: true, dryRun: true, cwd, worktrees: paths.map(path => ({ path, wouldRemove: false, why: 'deletion is disabled in v1' })) }
      } catch (error) { return refuse(`could not list worktrees: ${String(error)}`, ['readable git worktree']) }
    },
  }
}
