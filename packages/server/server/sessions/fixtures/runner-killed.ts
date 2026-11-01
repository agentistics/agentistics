/**
 * runner-killed.ts — for `structured-relay-orphans.test.ts`: plays a `bun test` RUNNER that is
 * OOM-killed. It marks itself as the runner (what `scripts/test-preload.ts` does), starts a structured
 * child through the durable store, prints the session directory once the relay is up, and dies by
 * SIGKILL — nothing of its own can clean up. The child is a plain `sleep`: like a real harness it
 * knows nothing about tests, so only the RELAY can end it. Usage: <root> <cwd>.
 */
import path from 'node:path'
import { durableStore } from '../structured-durable'
import { TEST_RUNNER_PID_ENV } from '../structured-relay'

process.env[TEST_RUNNER_PID_ENV] = String(process.pid)
const [root, cwd] = process.argv.slice(2) as [string, string]
const store = durableStore(root)
const t = store.create('m-1', {
  v: 1, harness: 'gemini',
  spawn: { id: 'm-1', harness: 'gemini', cwd },
  backend: { id: 'm-1', cwd },
})
t.launch('sleep', ['300'], cwd, {})
const end = Date.now() + 8000
while (!store.isAlive('m-1') && Date.now() < end) await new Promise(r => setTimeout(r, 20))
process.stdout.write(`${path.join(root, 'm-1')}\n`)
process.kill(process.pid, 'SIGKILL')
