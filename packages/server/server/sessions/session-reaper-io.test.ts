/**
 * Real child processes: a session's tree — including a member that left the process group (setsid) —
 * is spawned carrying a session marker, the session is closed, and every pid must be gone.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { collectorPass, readReapProcs, reapClosedSessions, stopSessionProcesses } from './session-reaper-io'
import type { EscalateIO } from './kill-escalate'

const linux = process.platform === 'linux'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const alive = (pid: number) => {
  try { process.kill(pid, 0) } catch { return false }
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]![0] !== 'Z' } catch { return false }
}
const spawned: number[] = []
afterEach(() => { for (const p of spawned.splice(0)) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } } })

/** sh → (sleep, setsid sleep, sh → sleep). Resolves with every pid carrying the marker. */
async function tree(id: string): Promise<number[]> {
  const sh = spawn('sh', ['-c', 'sleep 300 & setsid sleep 300 & sh -c "sleep 300" & wait'], {
    env: { ...process.env, AGENTOP_MANAGED_ID: id }, stdio: 'ignore', detached: true,
  })
  spawned.push(sh.pid!)
  for (let i = 0; i < 100; i++) {
    const mine = (readReapProcs() ?? []).filter(p => p.managedId === id).map(p => p.pid)
    if (mine.length >= 4) {
      await sleep(200) // let the last fork land
      const all = (readReapProcs() ?? []).filter(p => p.managedId === id).map(p => p.pid)
      spawned.push(...all)
      return all
    }
    await sleep(20)
  }
  throw new Error('the tree did not come up')
}
const uid = () => `t${Math.random().toString(36).slice(2, 10)}`

describe.if(linux)('stopSessionProcesses (kill time)', () => {
  test('stops the whole tree, the setsid member included', async () => {
    const id = uid()
    const pids = await tree(id)
    const r = await stopSessionProcesses(id)
    expect(r.stuck).toEqual([])
    expect(r.stopped.sort()).toEqual([...pids].sort())
    await sleep(50)
    expect(pids.filter(alive)).toEqual([])
  }, 15_000)

  test('MUTATION: with the signals disabled the same assertion catches every survivor', async () => {
    const id = uid()
    const pids = await tree(id)
    const noKill: EscalateIO = { alive: () => false, signal: () => true, sleep: async () => {}, now: () => Date.now() }
    await stopSessionProcesses(id, { stop: { io: noKill, term: () => {} } })
    expect(pids.filter(alive).sort()).toEqual([...pids].sort())
  }, 15_000)

  test('dry run names the tree and stops nothing', async () => {
    const id = uid()
    const pids = await tree(id)
    const r = await stopSessionProcesses(id, { dryRun: true })
    expect(r.found.map(f => f.pid).sort()).toEqual([...pids].sort())
    expect(pids.filter(alive).length).toBe(pids.length)
  }, 15_000)

  test('a process started AFTER the session ended is left alone', async () => {
    const id = uid()
    const pids = await tree(id)
    const r = await stopSessionProcesses(id, { endedMs: Date.now() - 60_000 })
    expect(r.stopped).toEqual([])
    expect(pids.filter(alive).length).toBe(pids.length)
  }, 15_000)
})

describe.if(linux)('reapClosedSessions (periodic)', () => {
  test('a session closed > grace ago, not listed alive: freed, with a count', async () => {
    const id = uid()
    const pids = await tree(id)
    const lines: string[] = []
    const r = await reapClosedSessions({
      readEnded: async () => new Map([[id, Date.now() + 1_000]]), liveIds: async () => new Set(),
      nowMs: Date.now() + 5 * 60_000, log: l => lines.push(l),
    })
    expect(r.processes).toBe(pids.length)
    expect(r.sessions).toBe(1)
    expect(lines.join('\n')).toContain('leftover processes of closed sessions')
    await sleep(50)
    expect(pids.filter(alive)).toEqual([])
  }, 15_000)

  test('listed alive by the backend: untouched; backend unlisted: nothing judged', async () => {
    const id = uid()
    const pids = await tree(id)
    const ended = async () => new Map([[id, Date.now() + 1_000]])
    const nowMs = Date.now() + 5 * 60_000
    expect((await reapClosedSessions({ readEnded: ended, liveIds: async () => new Set([id]), nowMs, log: () => {} })).processes).toBe(0)
    expect((await reapClosedSessions({ readEnded: ended, liveIds: async () => null, nowMs, log: () => {} })).skippedWhy).toBe('backend could not be listed')
    expect(pids.filter(alive).length).toBe(pids.length)
  }, 15_000)

  test('dry run (the collector pass) counts and stops nothing', async () => {
    const id = uid()
    const pids = await tree(id)
    const r = await collectorPass({ dryRun: true, log: () => {}, deps: { readEnded: async () => new Map([[id, Date.now() + 1_000]]), liveIds: async () => new Set(), nowMs: Date.now() + 5 * 60_000 } })
    expect(r.dryRun).toBe(true)
    expect(r.found?.map(f => f.pid).sort()).toEqual([...pids].sort())
    expect(pids.filter(alive).length).toBe(pids.length)
  }, 15_000)
})

describe.if(linux)('the structured fixture', () => {
  test('fake-structured-agent exits when its parent dies, even with stdin still open', async () => {
    const agent = path.join(import.meta.dir, 'fixtures', 'fake-structured-agent.ts')
    // The parent shell starts the agent in the background and then sits; the agent's stdin is OUR pipe.
    const sh = spawn('sh', ['-c', `exec 3<&0; "${process.execPath}" run "${agent}" <&3 & echo $!; sleep 300`], { stdio: ['pipe', 'pipe', 'ignore'], detached: true })
    spawned.push(sh.pid!)
    const pid = await new Promise<number>(res => sh.stdout!.once('data', (b: Buffer) => res(Number(String(b).trim()))))
    spawned.push(pid)
    await sleep(500)
    expect(alive(pid)).toBe(true)
    process.kill(sh.pid!, 'SIGKILL')
    for (let i = 0; i < 60 && alive(pid); i++) await sleep(50)
    expect(alive(pid)).toBe(false)
    sh.stdin!.end()
  }, 15_000)
})
