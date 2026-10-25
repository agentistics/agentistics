import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('session list clears a server marker inherited from its parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-cli-process-'))
  try {
    // Observe the real entry point after it dispatches the command, including explicit exits.
    const preload = join(dir, 'observe.ts')
    await writeFile(preload, `process.on('exit', () => console.error('server-marker=' + process.env.SERVE_STATIC))`)
    const child = Bun.spawn([process.execPath, '--preload', preload,
      join(import.meta.dir, '../bin/cli.ts'), 'session', 'list'], {
      env: { ...process.env, HOME: dir, USERPROFILE: dir, AGENTISTICS_DIR: join(dir, 'data'),
        CLAUDE_CONFIG_DIR: join(dir, 'claude'), SERVE_STATIC: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, out, err] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(code).toBe(0)
    expect(err).toContain('server-marker=undefined')
    expect(out + err).not.toContain('[sessions] refused')
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 15_000)
