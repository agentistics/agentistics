import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planTmuxLaunch, planTmuxLiteral, sweepStaleLaunchers, tmuxSpawnError } from './tmux-launch'
import { planSpawn } from './spawn-spec'
import { spawnArgs } from './tmux-cli'

const relay = 'Owner: "olá" \'ação\' $HOME $(exit 99) `exit 98` \\ fim\n'.repeat(300) + '\n\n'
const profile = { defaultTerminal: null, truecolorTerm: null }

describe('tmux launch payload transport', () => {
  test.skipIf(process.platform === 'win32')('a 12 KB+ relay stays off the tmux command and reaches the child byte for byte', async () => {
    expect(Buffer.byteLength(relay)).toBeGreaterThan(12 * 1024)
    const dir = await mkdtemp(join(tmpdir(), 'tmux-launch-'))
    try {
      // A fake harness records its actual argv, including empty args and trailing newlines.
      const harness = join(dir, 'fake harness')
      await writeFile(harness, '#!/bin/sh\nprintf \'%s\\000\' "$@"\n', { mode: 0o700 })
      const argv = [harness, '--append-system-prompt', relay, '', 'brief with \'quotes\'']
      const launch = planTmuxLaunch(argv, dir, 'test')
      expect(launch.file).toBeDefined()
      const tmux = spawnArgs(profile, { id: 'test', cwd: dir, argv: launch.argv })
      expect(Buffer.byteLength(tmux.join('\0'))).toBeLessThan(2048)
      expect(tmux.join('\0')).not.toContain('Owner:')
      await writeFile(launch.file!.path, launch.file!.text, { mode: 0o600 })
      const child = Bun.spawn(launch.argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(await child.exited).toBe(0)
      expect(err).toBe('')
      expect(out.split('\0')).toEqual([...argv.slice(1), ''])
      expect(existsSync(launch.file!.path)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a large single-line brief and UTF-8 byte length both select a file', () => {
    expect(planTmuxLaunch(['claude', 'x'.repeat(12 * 1024)], '/context/s', 'a').file).toBeDefined()
    expect(planTmuxLaunch(['claude', 'á'.repeat(1100)], '/context/s', 'b').file).toBeDefined()
    expect(planTmuxLaunch(['claude', 'one\ntwo'], '/context/s', 'c').file).toBeDefined()
  })

  test('a short no-handoff spawn keeps exactly the original tmux invocation', () => {
    const argv = ['claude', '--model', 'sonnet', 'hello']
    const launch = planTmuxLaunch(argv, '/context/s', 'unused')
    expect(launch.argv).toBe(argv)
    expect(launch.file).toBeUndefined()
    expect(spawnArgs(profile, { id: 's', cwd: '/project', argv: launch.argv }))
      .toEqual(spawnArgs(profile, { id: 's', cwd: '/project', argv }))
  })

  for (const harness of ['claude', 'codex', 'gemini', 'antigravity', 'kimi', 'copilot'] as const) {
    test(`${harness}: context delivery channel and full content survive launch planning`, () => {
      const context = { text: relay, block: `<agentistics-context>\n${relay}</agentistics-context>`, dir: '/context/s' }
      const result = planSpawn({ harness, cwd: '/project', prompt: 'continue', context })
      if (!result.ok) throw new Error(JSON.stringify(result.error))
      const before = JSON.stringify(result.plan)
      const launch = planTmuxLaunch(result.plan.argv, context.dir, 'test')
      expect(Buffer.byteLength(spawnArgs(profile, { id: 's', cwd: '/project', argv: launch.argv }).join('\0')))
        .toBeLessThan(2048)
      expect(JSON.stringify(result.plan)).toBe(before)
      if (harness === 'copilot') {
        expect(result.plan.contextFile?.text).toBe(relay)
        expect(result.plan.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBe(context.dir)
      } else if (harness === 'kimi') {
        expect(result.plan.initialPrompt?.text).toBe(`${context.block}\n\ncontinue`)
        const delivery = planTmuxLiteral('s', result.plan.initialPrompt!.text!)!
        expect(delivery.stdin).toBe(`${context.block}\n\ncontinue`)
        expect(Buffer.byteLength([...delivery.load, ...delivery.paste].join('\0'))).toBeLessThan(2048)
        expect(delivery.paste).toContain('-r')
        expect(delivery.paste).toContain('-d')
        expect(delivery.paste).not.toContain('-p')
      } else {
        expect(launch.file).toBeDefined()
        // Payload quoting is executed against a fake harness in the round-trip test above.
        expect(result.plan.argv.join('\n')).toContain(harness === 'codex' ? JSON.stringify(relay) : relay)
      }
    })
  }

  test('short first-message delivery retains literal send-keys', () => {
    expect(planTmuxLiteral('s', 'continue')).toBeNull()
  })
})

describe('tmux spawn diagnostics', () => {
  test('includes stderr, exit code and any stdout', () => {
    expect(tmuxSpawnError(1, 'stdout detail\n', 'command too long\n'))
      .toBe('tmux new-session failed (code 1): command too long\nstdout detail')
  })
  test('keeps a useful fallback when both streams are empty', () => {
    expect(tmuxSpawnError(127, '', '')).toBe('tmux new-session failed (code 127)')
  })
})

describe('launcher cleanup', () => {
  test('sweep removes only old launcher-named files in session dirs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmux-sweep-'))
    try {
      await mkdir(join(root, 's1'))
      const old = join(root, 's1', 'launch-abc-123.sh')
      const fresh = join(root, 's1', 'launch-def-456.sh')
      const other = join(root, 's1', 'context.md')
      for (const f of [old, fresh, other]) await writeFile(f, 'x', { mode: 0o600 })
      const past = new Date(Date.now() - 3_600_000)
      await utimes(old, past, past)
      await utimes(other, past, past)
      expect(await sweepStaleLaunchers(root)).toBe(1)
      expect(existsSync(old)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
      expect(existsSync(other)).toBe(true)
      expect(await sweepStaleLaunchers(join(root, 'missing'))).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
