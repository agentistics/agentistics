/** Real tmux check; run ONLY in agentop run --rm. Uses that run's isolated data/socket. */
import { openShell, closeShells, listShells } from '../server/sessions/shell-backend'
import { createShellTerminal } from '../server/sessions/shell-terminal'
import { shellTmux } from '../server/sessions/shell-tmux'
import { handleShellRoute } from '../server/sessions/shell-web'
import type { StartHost } from '../server/cli-start'
import { SHELL_SOCKET } from '../server/sessions/tmux-cli'

if (!process.env.HOME?.includes('agentistics-throwaway')) throw new Error('Run under agentop run --rm')
const terminal = createShellTerminal(shellTmux)
const results: unknown[] = []
for (let i = 0; i < 2; i++) {
  const stages: Record<string, number> = {}
  const opened = await openShell({ sessionId: 'qa-session', cwd: process.cwd(), timing: (s, ms) => stages[s] = ms })
  if (!opened.ok) throw new Error(opened.reason)
  try {
    await terminal.sendText(opened.shell.id, "printf 'QA_%s_OK\\n' TERMINAL")
    await terminal.sendKey(opened.shell.id, 'Enter')
    let output = ''
    const start = performance.now()
    while (performance.now() - start < 5000) {
      output = (await terminal.capture(opened.shell.id, 100))?.lines.join('\n') ?? ''
      if (output.includes('QA_TERMINAL_OK')) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!output.includes('QA_TERMINAL_OK')) throw new Error('command output not captured')
    results.push({ attempt: i + 1, stages, commandAndCaptureMs: performance.now() - start })
  } finally { await closeShells([opened.shell.id]) }
  if ((await listShells()).length !== 0) throw new Error('closed shell still listed')
}
let fleetCalls = 0
const host = { sessions: async () => {
  fleetCalls++
  await new Promise(resolve => setTimeout(resolve, 200))
  return { sessions: [{ id: 'qa-session', cwd: process.cwd() }] }
} } as unknown as StartHost
for (const fast of [false, true]) {
  const url = new URL('http://qa/api/shell/open')
  const start = performance.now()
  const res = await handleShellRoute(new Request(url, { method: 'POST', body: JSON.stringify({ sessionId: 'qa-session' }) }), url, host, 'en', fast ? { targetRows: async () => [{ id: 'qa-session', cwd: process.cwd() }] } : {})
  const body = await res!.json()
  if (!body.ok) throw new Error(JSON.stringify(body))
  results.push({ fastTargetRecords: fast, elapsedMs: performance.now() - start, timing: res!.headers.get('server-timing') })
  await closeShells([body.shell.id])
}
// Shut down only the dedicated empty throwaway socket, never the owner's.
if (!SHELL_SOCKET.includes('agentop-shell-')) throw new Error('non-isolated shell socket')
await shellTmux(['-L', SHELL_SOCKET, 'kill-server'])
console.log(JSON.stringify({ fleetCalls, simulatedFleetDelayMs: 200, results }, null, 2))
