import { afterAll, describe, expect, it } from 'bun:test'
import { tmuxBackend } from './backend-tmux'
import { collectOwnPids, procIO } from './kill-escalate'
import { TMUX_SOCKET } from './tmux-socket'

// Real tmux, on the throwaway socket `bun test`'s isolated data dir gives this process
// (`tmux-socket.ts`) — never the owner's `agentop` fleet. The guard below makes that a precondition.
const haveTmux = Bun.which('tmux') !== null && process.platform === 'linux' && TMUX_SOCKET !== 'agentop'

afterAll(async () => {
  if (!haveTmux) return
  const p = Bun.spawn(['tmux', '-L', TMUX_SOCKET, 'kill-server'], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
  await p.exited
})

describe.skipIf(!haveTmux)('tmuxBackend.kill — a harness that ignores the hang-up', () => {
  it('leaves no orphan behind: its own pids are SIGKILLed, and the kill is only confirmed once they are gone', async () => {
    const id = `killesc${Date.now().toString(36)}`
    // Ignores SIGHUP and SIGTERM, and `exec`s so the pane process IS the stubborn one — gemini's shape.
    await tmuxBackend.spawn({ id, cwd: '/tmp', argv: ['sh', '-c', "trap '' HUP TERM; exec sleep 120"] })
    let own: Awaited<ReturnType<typeof collectOwnPids>> = []
    for (let i = 0; i < 40 && own.length === 0; i++) {
      await new Promise(r => setTimeout(r, 50))
      own = await collectOwnPids((await tmuxBackend.listPanePids?.())?.get(id))
    }
    expect(own.length).toBeGreaterThan(0)

    expect(await tmuxBackend.kill(id)).toBe(true)

    const io = procIO()
    for (const r of own) expect(io.alive(r)).toBe(false)
    // …and killing it again is still success: "already gone" is the outcome the caller asked for.
    expect(await tmuxBackend.kill(id)).toBe(true)
  }, 20_000)
})
