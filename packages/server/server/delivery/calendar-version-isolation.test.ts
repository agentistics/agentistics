/**
 * `calendar.test.ts` stubs '../version' with `mock.module`, which does not undo itself: in the full run (ONE process) the next files
 * that import it (version, upgrade, self-guard, restart-pending) saw `compareVersions: () => 0`. The stub is now undone when its block
 * ends; this runs the two in the SAME process, calendar first, and requires a clean exit.
 */
import { expect, test } from 'bun:test'
import { join } from 'node:path'

test('calendar.test then version.test in one process: the stub does not leak', async () => {
  const server = join(import.meta.dir, '..')
  const env = { ...process.env }; delete env.AGENTISTICS_FLOWS
  const p = Bun.spawn([process.execPath, 'test', join(server, 'delivery', 'calendar.test.ts'), join(server, 'version.test.ts')], { stdout: 'pipe', stderr: 'pipe', env })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  expect(code, out + err).toBe(0)
  expect(out + err).not.toMatch(/\(fail\)/)
}, 120_000)
