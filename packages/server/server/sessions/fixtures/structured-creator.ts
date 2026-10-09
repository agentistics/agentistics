/**
 * structured-creator.ts — for `structured-durable.test.ts`: a process that starts a structured child
 * through the durable store, waits until its relay is up, and then DIES BY SIGKILL — no cleanup, no
 * goodbye, like a server taken down by `systemctl restart` or a crash. Usage: <root> <agent> <log> <cwd>.
 */
import { durableStore } from '../structured-durable'

const [root, agent, log, cwd] = process.argv.slice(2) as [string, string, string, string]
const store = durableStore(root)
const t = store.create('m-1', {
  v: 1, harness: 'gemini',
  spawn: { id: 'm-1', harness: 'gemini', cwd },
  backend: { id: 'm-1', cwd },
})
t.launch('bun', ['run', agent], cwd, { AGENT_LOG: log })
const end = Date.now() + 5000
while (!store.isAlive('m-1') && Date.now() < end) await new Promise(r => setTimeout(r, 20))
process.kill(process.pid, 'SIGKILL')
