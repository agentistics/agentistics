import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `attachmentPathByNameReal` is the REAL (symlink-resolved) recheck for `GET
 * /api/fleet/attachment/by-name` — see the header on that function in `attachment-web.ts`. A
 * LEXICAL check on the requested NAME (`attachmentPathByName`) refuses a traversal spelled in the
 * request, but says nothing about what `ATTACHMENT_DIR/<name>` actually IS on disk: a symlink
 * PLANTED inside the attachments directory, pointing outside it, resolves that check exactly like
 * an ordinary file and would then be served straight off its target.
 *
 * `ATTACHMENT_DIR` is computed once, at `config.ts` load, from `AGENTISTICS_DIR` — and this
 * machine's real one already holds live attachments that a test must never touch (see the note atop
 * `resolveAttachmentReadReal`'s own describe block in `attachment-web.test.ts`). So, the same shape
 * `subtask-groupid-patch.test.ts` / `task-done-needs-session.test.ts` use: each scenario runs in its
 * OWN process, pointed at its own `AGENTISTICS_DIR`, with a REAL symlink planted on disk.
 */

const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-attachment-symlink-'))
  const outside = await mkdtemp(join(tmpdir(), 'agentop-attachment-symlink-outside-'))
  const script = `
    const { mkdir, writeFile, symlink, realpath } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const attachmentWeb = await import(${JSON.stringify(join(SESSIONS_DIR, 'attachment-web.ts'))})
    const ATTACHMENT_DIR = attachmentWeb.ATTACHMENT_DIR
    const OUTSIDE = ${JSON.stringify(outside)}
    await mkdir(ATTACHMENT_DIR, { recursive: true })
    ${body}
  `
  const proc = Bun.spawn([process.execPath, '-e', script], {
    env: { ...process.env, AGENTISTICS_DIR: dir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`script failed (${code}): ${err.trim().split('\n').slice(-8).join(' | ')}`)
  }
  const line = out.trim().split('\n').filter(Boolean).at(-1) ?? '{}'
  return JSON.parse(line)
}

test('a symlink planted INSIDE the attachments dir, pointing OUTSIDE it, is refused', async () => {
  const out = await run(`
    await writeFile(join(OUTSIDE, 'secret.txt'), 'nope')
    await symlink(join(OUTSIDE, 'secret.txt'), join(ATTACHMENT_DIR, 'escape-link.png'))
    const resolved = await attachmentWeb.attachmentPathByNameReal('escape-link.png')
    console.log(JSON.stringify({ resolved }))
  `)
  expect(out).toEqual({ resolved: null })
})

test('an ordinary, legitimately-minted attachment name still resolves to its real path', async () => {
  const out = await run(`
    const target = join(ATTACHMENT_DIR, '724e7aa8-image.png')
    await writeFile(target, 'x')
    const resolved = await attachmentWeb.attachmentPathByNameReal('724e7aa8-image.png')
    const realTarget = await realpath(target)
    console.log(JSON.stringify({ resolved, realTarget }))
  `) as { resolved: string | null; realTarget: string }
  expect(out.resolved).toBe(out.realTarget)
})

test('a symlink INSIDE the attachments dir pointing at another file INSIDE it still resolves — containment, not symlinks in general, is the rule', async () => {
  const out = await run(`
    const target = join(ATTACHMENT_DIR, 'real-target.png')
    await writeFile(target, 'y')
    await symlink(target, join(ATTACHMENT_DIR, 'inside-link.png'))
    const resolved = await attachmentWeb.attachmentPathByNameReal('inside-link.png')
    const realTarget = await realpath(target)
    console.log(JSON.stringify({ resolved, realTarget }))
  `) as { resolved: string | null; realTarget: string }
  expect(out.resolved).toBe(out.realTarget)
})

test('a name refused lexically never reaches disk, and stays refused', async () => {
  const out = await run(`
    const resolved = await attachmentWeb.attachmentPathByNameReal('../../.ssh/id_rsa')
    console.log(JSON.stringify({ resolved }))
  `)
  expect(out).toEqual({ resolved: null })
})
