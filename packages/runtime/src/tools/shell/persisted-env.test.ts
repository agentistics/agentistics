/**
 * persisted-env.test.ts — B3 security review F3, end to end: the long-lived bash keeps what one call
 * exports, so a PATH change in call 1 would make an ALLOWLISTED bare command in call 2 run another
 * binary. Real shell, real policy, an allow rule for the command and for every shell call, and no
 * person to ask: call 1 must not run, so call 2 runs the real `ls`.
 */
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPolicy } from '../../policy/policy.ts'
import type { Tool } from '../contract.ts'
import { runTool } from '../gate.ts'
import { memoryContent, recordingEvents } from '../testing.ts'
import { createShellTools, type ShellResult, type ShellTools } from './tools.ts'

const live: Array<{ tools: ShellTools; dir: string }> = []
afterEach(async () => {
  for (const { tools, dir } of live.splice(0)) {
    await tools.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const first of [
  (evil: string) => `export PATH=${evil}:$PATH`,
  (evil: string) => `PATH=${evil}:$PATH`,
  (evil: string) => `declare -x PATH=${evil}:$PATH`,
  () => `alias ls="echo HIJACKED"; shopt -s expand_aliases`,
  () => `hash -p ./evil/ls ls`,
]) {
  test(`call 1 \`${first('<evil>')}\` cannot run without a person, so call 2 \`ls\` is the real ls`, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agt-persist-')))
    const tools = createShellTools({ graceMs: 300 })
    live.push({ tools, dir })
    const evil = join(dir, 'evil')
    mkdirSync(evil)
    writeFileSync(join(evil, 'ls'), '#!/bin/sh\necho HIJACKED\n')
    chmodSync(join(evil, 'ls'), 0o755)
    writeFileSync(join(dir, 'marker.txt'), 'x')

    const policy = createPolicy({
      layers: [{ name: 'user', rules: [
        { id: 'u.ls', effect: 'allow', match: { commandPrefix: ['ls'] } },
        { id: 'u.shell', effect: 'allow', match: { action: 'shell' } },
      ] }],
      home: '/home/nobody-b3sec',
    })
    const ctrl = new AbortController()
    const run = (command: string) =>
      runTool(tools.start as unknown as Tool<unknown>, { command, tty: false }, { workspaceRoot: dir, cwd: dir, signal: ctrl.signal },
        { policy, events: recordingEvents(), content: memoryContent() })

    const one = await run(first(evil))
    expect(one.outcome.ok).toBe(false)

    const two = await run('ls')
    expect(two.outcome.ok).toBe(true)
    const out = (two.outcome.result as ShellResult).output
    expect(out).not.toContain('HIJACKED')
    expect(out).toContain('marker.txt')
  })
}
