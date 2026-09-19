import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTreeEntry, deleteTreeEntry, listChildren, readTreeFile, renameTreeEntry, resolveSessionDirectory,
  readTreeMedia, searchTree, walkPlain, writeTreeFile,
} from './editor-fs'
import { MEDIA_VIEW_LIMITS } from './editor-media'
import type { StartHost } from '../cli-start'

// Same reason repo-probe.test.ts strips these: a pre-commit hook running from a linked worktree
// exports GIT_DIR / GIT_INDEX_FILE pointing at the OUTER checkout, and `-C`/`cwd` do not override
// GIT_DIR for repository discovery.
const git = (cwd: string, ...args: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_PREFIX
  return execFileSync('git', args, { cwd, encoding: 'utf8', env })
}

let root = ''
let gitRepo = ''
let plainDir = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentistics-editor-'))

  gitRepo = join(root, 'gitrepo')
  mkdirSync(gitRepo)
  git(gitRepo, 'init', '-q', '-b', 'main')
  git(gitRepo, 'config', 'user.email', 't@t')
  git(gitRepo, 'config', 'user.name', 't')
  mkdirSync(join(gitRepo, 'src'))
  writeFileSync(join(gitRepo, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(gitRepo, 'README.md'), '# hi\n')
  writeFileSync(join(gitRepo, '.gitignore'), 'ignored.log\n')
  writeFileSync(join(gitRepo, 'ignored.log'), 'should not appear\n')
  git(gitRepo, 'add', 'src/a.ts', 'README.md', '.gitignore')
  git(gitRepo, 'commit', '-q', '-m', 'init')
  writeFileSync(join(gitRepo, 'src', 'untracked.ts'), 'export const b = 2\n')

  plainDir = join(root, 'plain')
  mkdirSync(plainDir)
  writeFileSync(join(plainDir, 'x.txt'), 'x\n')
  mkdirSync(join(plainDir, 'sub'))
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

// `StartHost` (via `ControlHost`) carries many members no test here calls — the same posture
// `shell-web.test.ts`'s own `{} as StartHost` already takes for a host that is never driven
// beyond what `resolveSessionDirectory` reads (`host.sessions`). `withSessions` overrides just
// that one method, so each test states only the fleet row it is testing.
const noHost = {} as StartHost
const withSessions = (sessions: NonNullable<StartHost['sessions']>): StartHost => ({ ...noHost, sessions })

describe('resolveSessionDirectory', () => {
  test('an unknown id refuses unknown-session', async () => {
    const r = await resolveSessionDirectory(noHost, 'nope')
    expect(r).toEqual({ ok: false, reason: 'unknown-session' })
  })

  test('a live fleet row wins, and its cwd is checked for existence', async () => {
    const host = withSessions(async () => ({
      sessions: [{ id: 's1', conversationId: 'c1', cwd: gitRepo } as never],
      attention: 0,
      rang: [],
    }))
    const r = await resolveSessionDirectory(host, 's1')
    expect(r).toEqual({ ok: true, dir: gitRepo })
  })

  test('a live row naming a directory that does not exist refuses cwd-missing', async () => {
    const host = withSessions(async () => ({
      sessions: [{ id: 's2', conversationId: 'c2', cwd: join(root, 'gone') } as never],
      attention: 0,
      rang: [],
    }))
    const r = await resolveSessionDirectory(host, 's2')
    expect(r).toEqual({ ok: false, reason: 'cwd-missing' })
  })
})

describe('listChildren', () => {
  test('a git repo lists tracked + untracked-not-ignored, never the gitignored file', async () => {
    const r = await listChildren(gitRepo, '')
    // `.gitignore` itself was `git add`ed in beforeAll (so its own rule takes effect from the
    // commit, not merely from being present on disk) and is therefore a TRACKED file like any
    // other — it belongs in the listing. `ignored.log` is the one this test's name is about: it
    // matches `.gitignore`'s own pattern and must never appear.
    expect(r).toEqual({
      ok: true,
      children: [
        { name: 'src', kind: 'dir' },
        { name: '.gitignore', kind: 'file' },
        { name: 'README.md', kind: 'file' },
      ],
    })
  })

  test('listing a subdirectory of a git repo strips the parent prefix', async () => {
    const r = await listChildren(gitRepo, 'src')
    expect(r).toEqual({
      ok: true,
      children: [
        { name: 'a.ts', kind: 'file' },
        { name: 'untracked.ts', kind: 'file' },
      ],
    })
  })

  test('a plain (non-git) directory falls back to a bare readdir', async () => {
    const r = await listChildren(plainDir, '')
    expect(r).toEqual({
      ok: true,
      children: [
        { name: 'sub', kind: 'dir' },
        { name: 'x.txt', kind: 'file' },
      ],
    })
  })

  test('a path that does not exist on disk refuses not-found', async () => {
    const r = await listChildren(gitRepo, 'nope')
    expect(r).toEqual({ ok: false, reason: 'not-found' })
  })

  test('a path that names a FILE, not a directory, refuses not-a-directory', async () => {
    const r = await listChildren(gitRepo, 'README.md')
    expect(r).toEqual({ ok: false, reason: 'not-a-directory' })
  })

  test('a .. escape is refused before anything is read', async () => {
    const r = await listChildren(gitRepo, '../../etc')
    expect(r).toEqual({ ok: false, reason: 'escaped' })
  })

  test('a symlink INSIDE the tree pointing outside it is refused, not followed', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'nope\n')
    symlinkSync(outside, join(plainDir, 'escape-link'))
    const r = await listChildren(plainDir, 'escape-link')
    expect(r).toEqual({ ok: false, reason: 'escaped' })
  })
})

describe('listChildren — empty (non-ignored) directories are listed even though git tracks no file in them', () => {
  // Isolated from `gitRepo` above so this block's exact `toEqual`s never have to track that
  // fixture's own unrelated tracked/untracked/ignored shape.
  let repo = ''

  beforeAll(() => {
    repo = join(root, 'empty-dirs-repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'tracked.txt'), 'k\n')
    git(repo, 'add', 'tracked.txt')
    git(repo, 'commit', '-q', '-m', 'init')

    mkdirSync(join(repo, 'empty-at-root'))

    mkdirSync(join(repo, 'sub'))
    writeFileSync(join(repo, 'sub', 'file.txt'), 'f\n')
    git(repo, 'add', 'sub/file.txt')
    git(repo, 'commit', '-q', '-m', 'add sub file')
    mkdirSync(join(repo, 'sub', 'empty-in-sub'))

    writeFileSync(join(repo, '.gitignore'), 'build/\nnode_modules/\n')
    git(repo, 'add', '.gitignore')
    git(repo, 'commit', '-q', '-m', 'add gitignore')
    mkdirSync(join(repo, 'build'))
    mkdirSync(join(repo, 'node_modules'))

    mkdirSync(join(repo, 'untracked-with-file'))
    writeFileSync(join(repo, 'untracked-with-file', 'inner.txt'), 'i\n')
  })

  test('an empty directory at the root is listed as a dir', async () => {
    const r = await listChildren(repo, '')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.children).toContainEqual({ name: 'empty-at-root', kind: 'dir' })
  })

  test('an empty directory inside a tracked subfolder is listed as a dir, at that level', async () => {
    const r = await listChildren(repo, 'sub')
    expect(r).toEqual({
      ok: true,
      children: [
        { name: 'empty-in-sub', kind: 'dir' },
        { name: 'file.txt', kind: 'file' },
      ],
    })
  })

  test('an empty directory matched by .gitignore (a directory pattern) is never listed', async () => {
    const r = await listChildren(repo, '')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.children.some(c => c.name === 'build')).toBe(false)
      expect(r.children.some(c => c.name === 'node_modules')).toBe(false)
    }
  })

  test('an untracked NON-empty directory keeps working exactly as before', async () => {
    const r = await listChildren(repo, '')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.children).toContainEqual({ name: 'untracked-with-file', kind: 'dir' })
    const inner = await listChildren(repo, 'untracked-with-file')
    expect(inner).toEqual({ ok: true, children: [{ name: 'inner.txt', kind: 'file' }] })
  })

  test('the whole root listing is exactly: tracked + untracked + empty dirs, ignored dirs excluded', async () => {
    const r = await listChildren(repo, '')
    expect(r).toEqual({
      ok: true,
      children: [
        { name: 'empty-at-root', kind: 'dir' },
        { name: 'sub', kind: 'dir' },
        { name: 'untracked-with-file', kind: 'dir' },
        { name: '.gitignore', kind: 'file' },
        { name: 'tracked.txt', kind: 'file' },
      ],
    })
  })
})

describe('listChildren — a raw fs mutation of a git-TRACKED path never leaves a phantom row', () => {
  // The Studio's rename/delete act with `fs.rename`/`rm`, not `git mv`/`git rm` — so the INDEX
  // still names the old path after the disk no longer does. A fresh repo, isolated from the
  // `gitRepo` fixture above (whose own tests rely on its exact tracked/untracked/ignored shape).
  let repo = ''

  beforeAll(() => {
    repo = join(root, 'phantom-repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    mkdirSync(join(repo, 'folder'))
    writeFileSync(join(repo, 'folder', 'renamed-from.txt'), 'r\n')
    writeFileSync(join(repo, 'deleted-file.txt'), 'd\n')
    mkdirSync(join(repo, 'deleted-folder'))
    writeFileSync(join(repo, 'deleted-folder', 'a.txt'), 'a\n')
    writeFileSync(join(repo, 'deleted-folder', 'b.txt'), 'b\n')
    writeFileSync(join(repo, 'kept.txt'), 'k\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
  })

  test('a tracked file renamed via raw fs.rename drops the old name and shows the new one', async () => {
    renameSync(join(repo, 'folder', 'renamed-from.txt'), join(repo, 'folder', 'renamed-to.txt'))
    const r = await listChildren(repo, 'folder')
    expect(r).toEqual({ ok: true, children: [{ name: 'renamed-to.txt', kind: 'file' }] })
  })

  test('a tracked file deleted via raw fs.rm (not git rm) no longer appears', async () => {
    rmSync(join(repo, 'deleted-file.txt'))
    const r = await listChildren(repo, '')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.children.some(c => c.name === 'deleted-file.txt')).toBe(false)
      expect(r.children.some(c => c.name === 'kept.txt')).toBe(true)
    }
  })

  test('a tracked FOLDER deleted via raw recursive fs.rm leaves no phantom directory row', async () => {
    rmSync(join(repo, 'deleted-folder'), { recursive: true, force: true })
    const r = await listChildren(repo, '')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.children.some(c => c.name === 'deleted-folder')).toBe(false)
  })
})

describe('readTreeFile', () => {
  test('reads text content and the file\'s current mtime', async () => {
    const r = await readTreeFile(gitRepo, 'README.md')
    expect(r.ok).toBe(true)
    if (r.ok && !r.binary) {
      expect(r.content).toBe('# hi\n')
      expect(r.mtimeMs).toBe(statSync(join(gitRepo, 'README.md')).mtimeMs)
    }
  })

  test('a binary file is reported as such, never sent as text', async () => {
    const binPath = join(plainDir, 'image.bin')
    writeFileSync(binPath, Buffer.from([0, 1, 2, 3, 0, 5]))
    const r = await readTreeFile(plainDir, 'image.bin')
    expect(r).toEqual({ ok: true, binary: true, name: 'image.bin', size: 6 })
  })

  test('a directory is refused as not-a-file', async () => {
    const r = await readTreeFile(gitRepo, 'src')
    expect(r).toEqual({ ok: false, reason: 'not-a-file' })
  })

  test('a missing file is refused as not-found', async () => {
    const r = await readTreeFile(gitRepo, 'nope.ts')
    expect(r).toEqual({ ok: false, reason: 'not-found' })
  })

  test('an image says WHICH kind it is, so the pane can render it instead of refusing it', async () => {
    writeFileSync(join(plainDir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const r = await readTreeFile(plainDir, 'shot.png')
    expect(r).toEqual({ ok: true, binary: true, name: 'shot.png', size: 4, media: 'image' })
  })

  test('a file whose extension is on the table is NEVER read for the binary sniff', async () => {
    // The sniff needs the bytes in memory, and this feature is what makes a half-gigabyte video
    // reachable through this route. A PNG holding plain ASCII proves the decision was the
    // extension's: `looksBinary` would have said text, and the answer is still `media: 'image'`.
    writeFileSync(join(plainDir, 'textual.png'), 'not actually a png at all\n')
    const r = await readTreeFile(plainDir, 'textual.png')
    expect(r).toEqual({ ok: true, binary: true, name: 'textual.png', size: 26, media: 'image' })
  })

  test('an SVG opens as TEXT — it is media-shaped and deliberately off the table', async () => {
    writeFileSync(join(plainDir, 'd.svg'), '<svg></svg>\n')
    const r = await readTreeFile(plainDir, 'd.svg')
    expect(r.ok).toBe(true)
    if (r.ok && !r.binary) expect(r.content).toBe('<svg></svg>\n')
  })

  test('over the ceiling it is a binary with the LIMIT named, not a media file', async () => {
    const big = join(plainDir, 'big.png')
    writeFileSync(big, Buffer.alloc(MEDIA_VIEW_LIMITS.image + 1))
    const r = await readTreeFile(plainDir, 'big.png')
    expect(r).toEqual({
      ok: true, binary: true, name: 'big.png', size: MEDIA_VIEW_LIMITS.image + 1,
      mediaOverLimit: { media: 'image', limit: MEDIA_VIEW_LIMITS.image },
    })
    if (r.ok && r.binary) expect(r.media).toBeUndefined()
    rmSync(big)
  })
})

describe('readTreeMedia', () => {
  test('answers the REAL path to stream, plus the type the closed table declares', async () => {
    writeFileSync(join(plainDir, 'ok.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const r = await readTreeMedia(plainDir, 'ok.png')
    expect(r).toEqual({
      ok: true, real: join(plainDir, 'ok.png'), name: 'ok.png', size: 4,
      mime: 'image/png', media: 'image',
    })
  })

  test('a lexical escape is refused — the same first half every function here applies', async () => {
    expect(await readTreeMedia(plainDir, '../gitrepo/README.md')).toEqual({ ok: false, reason: 'escaped' })
    expect(await readTreeMedia(plainDir, '/etc/hostname')).toEqual({ ok: false, reason: 'escaped' })
  })

  test('a symlink OUT of the tree is refused — the second half, on the resolved path', async () => {
    // The lexical check cannot see this one: the path is inside the root and the LINK is not.
    const outside = join(root, 'outside.png')
    writeFileSync(outside, Buffer.from([0x89, 0x50]))
    const link = join(plainDir, 'escape.png')
    if (!existsSync(link)) symlinkSync(outside, link)
    expect(await readTreeMedia(plainDir, 'escape.png')).toEqual({ ok: false, reason: 'not-found' })
  })

  test('a file that is not on the table is refused as not-media, never as octet-stream', async () => {
    writeFileSync(join(plainDir, 'blob.bin'), Buffer.from([0, 1, 2]))
    expect(await readTreeMedia(plainDir, 'blob.bin')).toEqual({ ok: false, reason: 'not-media' })
    writeFileSync(join(plainDir, 'd2.svg'), '<svg></svg>')
    expect(await readTreeMedia(plainDir, 'd2.svg')).toEqual({ ok: false, reason: 'not-media' })
  })

  test('the ceiling is re-applied HERE, not taken on trust from the read that preceded it', async () => {
    const big = join(plainDir, 'big2.png')
    writeFileSync(big, Buffer.alloc(MEDIA_VIEW_LIMITS.image + 1))
    expect(await readTreeMedia(plainDir, 'big2.png')).toEqual({
      ok: false, reason: 'too-big', limit: MEDIA_VIEW_LIMITS.image,
    })
    rmSync(big)
  })

  test('a directory and a missing file keep their own refusals', async () => {
    expect(await readTreeMedia(plainDir, 'sub')).toEqual({ ok: false, reason: 'not-a-file' })
    expect(await readTreeMedia(plainDir, 'nope.png')).toEqual({ ok: false, reason: 'not-found' })
  })
})

describe('writeTreeFile', () => {
  test('a matching mtime writes, and returns the NEW mtime', async () => {
    const before = statSync(join(gitRepo, 'README.md')).mtimeMs
    const out = await writeTreeFile(gitRepo, 'README.md', '# updated\n', before)
    expect(out.ok).toBe(true)
    expect(readFileSync(join(gitRepo, 'README.md'), 'utf8')).toBe('# updated\n')
    if (out.ok) expect(out.mtimeMs).toBeGreaterThanOrEqual(before)
  })

  test('a stale mtime is refused as a conflict, and the CURRENT disk content is returned', async () => {
    const target = join(gitRepo, 'README.md')
    const current = statSync(target).mtimeMs
    const out = await writeTreeFile(gitRepo, 'README.md', '# my edit\n', current - 999999)
    expect(out).toMatchObject({ ok: false, reason: 'conflict' })
    if (!out.ok && out.reason === 'conflict') {
      expect(out.content).toBe('# updated\n')
    }
    // The file on disk must be UNTOUCHED — this is the whole safety guarantee.
    expect(readFileSync(target, 'utf8')).toBe('# updated\n')
  })

  test('writing a new file under a path that does not exist yet fails not-found — this route never creates', async () => {
    const out = await writeTreeFile(gitRepo, 'brand-new.ts', 'x', 0)
    expect(out).toEqual({ ok: false, reason: 'not-found' })
  })

  test('a .. escape is refused before any write is attempted', async () => {
    const out = await writeTreeFile(gitRepo, '../../etc/passwd', 'x', 0)
    expect(out).toEqual({ ok: false, reason: 'escaped' })
  })
})

/**
 * A FILE THAT IS NOT UTF-8 IS NEVER SAVED BACK MANGLED — asserted over the BYTES ON DISK.
 *
 * A status code is not evidence here: the defect this pins returned `ok: true` and a strip saying
 * "Saved" while it replaced `0xE9` with `EF BF BD`. So every test reads the file back and compares
 * it byte for byte with what was there before anything was asked of it.
 */
describe('a file whose bytes are not valid UTF-8', () => {
  const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) // "café\n" in Latin-1 — no NUL anywhere

  test('the read refuses it with its own reason, and sends no lossy text', async () => {
    writeFileSync(join(plainDir, 'latin1.txt'), LATIN1)
    const r = await readTreeFile(plainDir, 'latin1.txt')
    expect(r).toEqual({ ok: false, reason: 'not-utf8' })
    expect(Buffer.compare(readFileSync(join(plainDir, 'latin1.txt')), LATIN1)).toBe(0)
  })

  test('a write with the CURRENT mtime — the exact path that used to corrupt it — is refused, bytes intact', async () => {
    const target = join(plainDir, 'latin1-write.txt')
    writeFileSync(target, LATIN1)
    // What the editor used to hold: the lenient decode, U+FFFD where the byte was.
    const lossy = LATIN1.toString('utf8')
    const out = await writeTreeFile(plainDir, 'latin1-write.txt', lossy, statSync(target).mtimeMs)
    expect(out).toEqual({ ok: false, reason: 'not-utf8' })
    expect([...readFileSync(target)]).toEqual([...LATIN1])
  })

  test('a STALE mtime over a non-UTF-8 file is refused the same way — no lossy "current content"', async () => {
    const target = join(plainDir, 'latin1-stale.txt')
    writeFileSync(target, LATIN1)
    const out = await writeTreeFile(plainDir, 'latin1-stale.txt', 'mine\n', statSync(target).mtimeMs - 999999)
    expect(out).toEqual({ ok: false, reason: 'not-utf8' })
    expect(Buffer.compare(readFileSync(target), LATIN1)).toBe(0)
  })

  test('a file rewritten in Latin-1 AFTER it was opened as UTF-8 is not overwritten either', async () => {
    const target = join(plainDir, 'reencoded.txt')
    writeFileSync(target, 'café\n', 'utf8')
    const read = await readTreeFile(plainDir, 'reencoded.txt')
    expect(read.ok).toBe(true)
    writeFileSync(target, LATIN1)
    // Even handed the mtime it has NOW (a client that re-stat'ed, or two writes inside one tick).
    const out = await writeTreeFile(plainDir, 'reencoded.txt', 'café edited\n', statSync(target).mtimeMs)
    expect(out).toEqual({ ok: false, reason: 'not-utf8' })
    expect(Buffer.compare(readFileSync(target), LATIN1)).toBe(0)
  })

  test('valid UTF-8 with a BOM and CRLF still reads, and writes back BYTE-IDENTICAL', async () => {
    const target = join(plainDir, 'bom-crlf.txt')
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ação ✓\r\n😀\r\n', 'utf8')])
    writeFileSync(target, bytes)
    const read = await readTreeFile(plainDir, 'bom-crlf.txt')
    if (!read.ok || read.binary) throw new Error('expected a text read')
    const out = await writeTreeFile(plainDir, 'bom-crlf.txt', read.content, read.mtimeMs)
    expect(out.ok).toBe(true)
    expect(Buffer.compare(readFileSync(target), bytes)).toBe(0)
  })
})

describe('createTreeEntry', () => {
  test('creates an empty file', async () => {
    const out = await createTreeEntry(plainDir, 'created.txt', 'file')
    expect(out).toEqual({ ok: true })
    expect(existsSync(join(plainDir, 'created.txt'))).toBe(true)
  })

  test('creates a folder', async () => {
    const out = await createTreeEntry(plainDir, 'created-dir', 'dir')
    expect(out).toEqual({ ok: true })
    expect(statSync(join(plainDir, 'created-dir')).isDirectory()).toBe(true)
  })

  test('refuses to overwrite something that already exists', async () => {
    const out = await createTreeEntry(plainDir, 'x.txt', 'file')
    expect(out).toEqual({ ok: false, reason: 'already-exists' })
  })

  test('a .. escape is refused', async () => {
    const out = await createTreeEntry(plainDir, '../escaped.txt', 'file')
    expect(out).toEqual({ ok: false, reason: 'escaped' })
  })

  test('creating inside a directory that does not exist yet fails not-found — no implicit mkdir -p', async () => {
    const out = await createTreeEntry(plainDir, 'nosuch/child.txt', 'file')
    expect(out).toEqual({ ok: false, reason: 'not-found' })
  })

  test('a name over the filesystem limit is refused as name-too-long, not a generic 500', async () => {
    const out = await createTreeEntry(plainDir, `${'a'.repeat(300)}.txt`, 'file')
    expect(out).toEqual({ ok: false, reason: 'name-too-long' })
  })

  test('creating inside a directory this process may not write to is refused as no-permission, not a generic 500', async () => {
    const locked = join(plainDir, 'locked-for-create')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    try {
      const out = await createTreeEntry(plainDir, 'locked-for-create/child.txt', 'file')
      expect(out).toEqual({ ok: false, reason: 'no-permission' })
    } finally {
      chmodSync(locked, 0o700)
    }
  })
})

describe('renameTreeEntry', () => {
  test('renames a file within the tree', async () => {
    writeFileSync(join(plainDir, 'to-rename.txt'), 'x')
    const out = await renameTreeEntry(plainDir, 'to-rename.txt', 'renamed.txt')
    expect(out).toEqual({ ok: true })
    expect(existsSync(join(plainDir, 'renamed.txt'))).toBe(true)
    expect(existsSync(join(plainDir, 'to-rename.txt'))).toBe(false)
  })

  test('refuses when the source does not exist', async () => {
    const out = await renameTreeEntry(plainDir, 'nope.txt', 'somewhere.txt')
    expect(out).toEqual({ ok: false, reason: 'not-found' })
  })

  test('refuses when the destination already exists', async () => {
    writeFileSync(join(plainDir, 'src-a.txt'), 'a')
    writeFileSync(join(plainDir, 'dst-b.txt'), 'b')
    const out = await renameTreeEntry(plainDir, 'src-a.txt', 'dst-b.txt')
    expect(out).toEqual({ ok: false, reason: 'already-exists' })
  })

  test('an escape on EITHER end is refused', async () => {
    writeFileSync(join(plainDir, 'src-c.txt'), 'c')
    expect(await renameTreeEntry(plainDir, 'src-c.txt', '../out.txt')).toEqual({ ok: false, reason: 'escaped' })
    expect(await renameTreeEntry(plainDir, '../out.txt', 'src-c.txt')).toEqual({ ok: false, reason: 'escaped' })
  })

  describe('into-itself — a drop a plain rename() would surface as an unhandled EINVAL', () => {
    test('a folder dropped onto itself (the drag computes `into/<own name>`) is refused lexically', async () => {
      mkdirSync(join(plainDir, 'into-self'))
      const out = await renameTreeEntry(plainDir, 'into-self', 'into-self/into-self')
      expect(out).toEqual({ ok: false, reason: 'into-itself' })
      // Lexical — nothing was touched on disk.
      expect(existsSync(join(plainDir, 'into-self'))).toBe(true)
    })

    test('a folder moved into its own descendant is refused the same way', async () => {
      mkdirSync(join(plainDir, 'into-desc'))
      mkdirSync(join(plainDir, 'into-desc', 'child'))
      const out = await renameTreeEntry(plainDir, 'into-desc', 'into-desc/child/into-desc')
      expect(out).toEqual({ ok: false, reason: 'into-itself' })
    })

    test('a SIBLING whose name merely starts the same is not caught by the descendant check', async () => {
      mkdirSync(join(plainDir, 'twin'))
      mkdirSync(join(plainDir, 'twin2'))
      // twin2 is not inside twin, so renaming twin into twin2 is an ordinary, legal move.
      const out = await renameTreeEntry(plainDir, 'twin', 'twin2/twin')
      expect(out).toEqual({ ok: true })
      expect(existsSync(join(plainDir, 'twin2', 'twin'))).toBe(true)
    })

    test('renaming a path onto ITSELF (the current-parent no-op) still answers already-exists, not into-itself', async () => {
      writeFileSync(join(plainDir, 'same-path.txt'), 'x')
      const out = await renameTreeEntry(plainDir, 'same-path.txt', 'same-path.txt')
      expect(out).toEqual({ ok: false, reason: 'already-exists' })
    })
  })

  describe('a destination folder that does not exist is not-found, not escaped', () => {
    test('a destination parent that simply is not there answers not-found', async () => {
      writeFileSync(join(plainDir, 'dst-parent-missing-src.txt'), 'x')
      const out = await renameTreeEntry(plainDir, 'dst-parent-missing-src.txt', 'no-such-parent/dst.txt')
      expect(out).toEqual({ ok: false, reason: 'not-found' })
    })

    test('a destination parent that EXISTS but escapes containment (a symlink out of the tree) still answers escaped', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'agentistics-outside-rename-dst-parent-'))
      symlinkSync(outside, join(plainDir, 'evil-dst-parent'))
      writeFileSync(join(plainDir, 'dst-parent-escape-src.txt'), 'x')
      const out = await renameTreeEntry(plainDir, 'dst-parent-escape-src.txt', 'evil-dst-parent/dst.txt')
      expect(out).toEqual({ ok: false, reason: 'escaped' })
      expect(existsSync(join(outside, 'dst.txt'))).toBe(false)
      rmSync(outside, { recursive: true, force: true })
    })
  })
})

describe('rename and delete act on the ENTRY, never on a symlink\'s target', () => {
  test('deleting a symlink removes the link and leaves its target', async () => {
    writeFileSync(join(plainDir, 'AGENTS-del.md'), 'the real one')
    symlinkSync('AGENTS-del.md', join(plainDir, 'CLAUDE-del.md'))
    expect(await deleteTreeEntry(plainDir, 'CLAUDE-del.md', false)).toEqual({ ok: true })
    expect(existsSync(join(plainDir, 'CLAUDE-del.md'))).toBe(false)
    expect(readFileSync(join(plainDir, 'AGENTS-del.md'), 'utf8')).toBe('the real one')
  })

  test('renaming a symlink moves the link and leaves its target where it is', async () => {
    writeFileSync(join(plainDir, 'AGENTS-ren.md'), 'the real one')
    symlinkSync('AGENTS-ren.md', join(plainDir, 'CLAUDE-ren.md'))
    expect(await renameTreeEntry(plainDir, 'CLAUDE-ren.md', 'CLAUDE-moved.md')).toEqual({ ok: true })
    expect(existsSync(join(plainDir, 'AGENTS-ren.md'))).toBe(true)
    expect(lstatSync(join(plainDir, 'CLAUDE-moved.md')).isSymbolicLink()).toBe(true)
  })

  test('recursively deleting a link to a folder removes the link, not the folder\'s contents', async () => {
    mkdirSync(join(plainDir, 'real-folder'))
    writeFileSync(join(plainDir, 'real-folder', 'keep.txt'), 'x')
    symlinkSync('real-folder', join(plainDir, 'folder-link'))
    expect(await deleteTreeEntry(plainDir, 'folder-link', true)).toEqual({ ok: true })
    expect(existsSync(join(plainDir, 'folder-link'))).toBe(false)
    expect(readFileSync(join(plainDir, 'real-folder', 'keep.txt'), 'utf8')).toBe('x')
  })

  test('a dangling link is still an entry: it can be deleted, and it blocks a rename onto its name', async () => {
    symlinkSync('does-not-exist', join(plainDir, 'dangling-a'))
    symlinkSync('does-not-exist', join(plainDir, 'dangling-b'))
    writeFileSync(join(plainDir, 'onto-dangling.txt'), 'x')
    expect(await renameTreeEntry(plainDir, 'onto-dangling.txt', 'dangling-b'))
      .toEqual({ ok: false, reason: 'already-exists' })
    expect(await deleteTreeEntry(plainDir, 'dangling-a', false)).toEqual({ ok: true })
    expect(existsSync(join(plainDir, 'onto-dangling.txt'))).toBe(true)
  })

  test('a lexical ../ path is refused before any filesystem call', async () => {
    expect(await deleteTreeEntry(plainDir, '../outside.txt', false)).toEqual({ ok: false, reason: 'escaped' })
  })
})

describe('a PARENT folder that is a symlink pointing outside the tree', () => {
  // The fix resolves only the parent (`entryContained`), so this is the containment rule every
  // mutation now rests on. Each case asserts the refusal AND that the outside file is untouched.
  const setup = (tag: string) => {
    const outside = mkdtempSync(join(tmpdir(), `agentistics-outside-${tag}-`))
    writeFileSync(join(outside, 'o.txt'), 'outside')
    mkdirSync(join(outside, 'odir'))
    writeFileSync(join(outside, 'odir', 'inner.txt'), 'outside')
    symlinkSync(outside, join(plainDir, `evil-${tag}`))
    return outside
  }

  test('delete (plain and recursive) through it is refused', async () => {
    const outside = setup('del')
    expect((await deleteTreeEntry(plainDir, 'evil-del/o.txt', false)).ok).toBe(false)
    expect((await deleteTreeEntry(plainDir, 'evil-del/odir', true)).ok).toBe(false)
    expect(readFileSync(join(outside, 'o.txt'), 'utf8')).toBe('outside')
    expect(readFileSync(join(outside, 'odir', 'inner.txt'), 'utf8')).toBe('outside')
    rmSync(outside, { recursive: true, force: true })
  })

  test('rename FROM through it is refused, so an outside file is never pulled into the tree', async () => {
    const outside = setup('from')
    expect((await renameTreeEntry(plainDir, 'evil-from/o.txt', 'stolen.txt')).ok).toBe(false)
    expect(existsSync(join(outside, 'o.txt'))).toBe(true)
    expect(existsSync(join(plainDir, 'stolen.txt'))).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })

  test('rename TO through it is refused, so a tree file is never pushed out', async () => {
    const outside = setup('to')
    writeFileSync(join(plainDir, 'stays-home.txt'), 'home')
    expect((await renameTreeEntry(plainDir, 'stays-home.txt', 'evil-to/pushed.txt')).ok).toBe(false)
    expect(existsSync(join(plainDir, 'stays-home.txt'))).toBe(true)
    expect(existsSync(join(outside, 'pushed.txt'))).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })

  test('create through it is refused and writes nothing outside', async () => {
    const outside = setup('create')
    expect((await createTreeEntry(plainDir, 'evil-create/new.txt', 'file')).ok).toBe(false)
    expect((await createTreeEntry(plainDir, 'evil-create/newdir', 'dir')).ok).toBe(false)
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
    expect(existsSync(join(outside, 'newdir'))).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })
})

describe('what the filesystem itself refuses comes back as a code, never a thrown host path', () => {
  test('moving a folder into its own child is into-itself', async () => {
    mkdirSync(join(plainDir, 'self-parent'))
    expect(await renameTreeEntry(plainDir, 'self-parent', 'self-parent/child'))
      .toEqual({ ok: false, reason: 'into-itself' })
  })

  test('moving a folder into its own child THROUGH a symlink is into-itself too', async () => {
    mkdirSync(join(plainDir, 'self-real'))
    symlinkSync('self-real', join(plainDir, 'self-alias'))
    expect(await renameTreeEntry(plainDir, 'self-real', 'self-alias/child'))
      .toEqual({ ok: false, reason: 'into-itself' })
    expect(existsSync(join(plainDir, 'self-real'))).toBe(true)
  })

  test('a path whose middle segment is a FILE is not-a-directory, for create and rename', async () => {
    writeFileSync(join(plainDir, 'plain-file.txt'), 'x')
    writeFileSync(join(plainDir, 'mover.txt'), 'x')
    expect(await createTreeEntry(plainDir, 'plain-file.txt/child', 'file'))
      .toEqual({ ok: false, reason: 'not-a-directory' })
    expect(await renameTreeEntry(plainDir, 'mover.txt', 'plain-file.txt/child'))
      .toEqual({ ok: false, reason: 'not-a-directory' })
  })
})

describe('creating an entry never writes through a dangling symlink', () => {
  test('a dangling link pointing OUTSIDE the tree blocks the create and nothing is written out there', async () => {
    const outside = join(root, 'outside-target-created-by-link.txt')
    symlinkSync(outside, join(plainDir, 'trap-link.txt'))
    expect(await createTreeEntry(plainDir, 'trap-link.txt', 'file')).toEqual({ ok: false, reason: 'already-exists' })
    expect(existsSync(outside)).toBe(false)
  })
})

describe('the session folder itself is never renamed or deleted', () => {
  for (const path of ['', '.', './', 'sub-for-root/..']) {
    test(`delete ${JSON.stringify(path)} recursive is refused and the folder survives`, async () => {
      mkdirSync(join(plainDir, 'sub-for-root'), { recursive: true })
      writeFileSync(join(plainDir, 'survivor.txt'), 'still here')
      expect(await deleteTreeEntry(plainDir, path, true)).toEqual({ ok: false, reason: 'is-root' })
      expect(readFileSync(join(plainDir, 'survivor.txt'), 'utf8')).toBe('still here')
    })
  }

  test('rename from or onto the root is refused', async () => {
    expect(await renameTreeEntry(plainDir, '.', 'elsewhere')).toEqual({ ok: false, reason: 'is-root' })
    writeFileSync(join(plainDir, 'to-root.txt'), 'x')
    expect(await renameTreeEntry(plainDir, 'to-root.txt', '')).toEqual({ ok: false, reason: 'is-root' })
    expect(existsSync(join(plainDir, 'to-root.txt'))).toBe(true)
  })
})

describe('deleteTreeEntry', () => {
  test('deletes a file', async () => {
    writeFileSync(join(plainDir, 'to-delete.txt'), 'x')
    const out = await deleteTreeEntry(plainDir, 'to-delete.txt', false)
    expect(out).toEqual({ ok: true })
    expect(existsSync(join(plainDir, 'to-delete.txt'))).toBe(false)
  })

  test('deletes an empty folder without needing recursive', async () => {
    mkdirSync(join(plainDir, 'empty-to-delete'))
    const out = await deleteTreeEntry(plainDir, 'empty-to-delete', false)
    expect(out).toEqual({ ok: true })
  })

  test('refuses a non-empty folder without recursive', async () => {
    mkdirSync(join(plainDir, 'full-to-delete'))
    writeFileSync(join(plainDir, 'full-to-delete', 'inner.txt'), 'x')
    const out = await deleteTreeEntry(plainDir, 'full-to-delete', false)
    expect(out).toEqual({ ok: false, reason: 'not-empty' })
    expect(existsSync(join(plainDir, 'full-to-delete', 'inner.txt'))).toBe(true)
  })

  test('recursive:true deletes a non-empty folder', async () => {
    mkdirSync(join(plainDir, 'full-to-delete-2'))
    writeFileSync(join(plainDir, 'full-to-delete-2', 'inner.txt'), 'x')
    const out = await deleteTreeEntry(plainDir, 'full-to-delete-2', true)
    expect(out).toEqual({ ok: true })
    expect(existsSync(join(plainDir, 'full-to-delete-2'))).toBe(false)
  })

  test('refuses when the target does not exist', async () => {
    const out = await deleteTreeEntry(plainDir, 'nope', false)
    expect(out).toEqual({ ok: false, reason: 'not-found' })
  })

  test('an escape is refused before any delete is attempted', async () => {
    // NOTE: not `'../plain'` as in the original brief — `plainDir` is `<root>/plain`, so
    // `resolve(plainDir, '../plain')` collapses back to `plainDir` itself (a coincidence of this
    // fixture's own directory name) rather than escaping it, and would have masqueraded as
    // `not-empty` given the leftover fixtures from earlier tests. `../secret.txt` is genuinely
    // outside `plainDir`, matching the non-colliding names every sibling escape test already uses
    // (`'../escaped.txt'`, `'../out.txt'`, `'../../etc'`).
    const out = await deleteTreeEntry(plainDir, '../secret.txt', false)
    expect(out).toEqual({ ok: false, reason: 'escaped' })
  })

  test('rm refusing with EACCES is answered as no-permission, not a generic 500', async () => {
    // `createTreeEntry`'s own test drives a REAL EACCES through `chmod`; delete's `fsRefusal`
    // mapping is the same function, so the injectable `rmFn` seam is enough to prove this branch
    // without needing a second real-filesystem permission fixture.
    mkdirSync(join(plainDir, 'no-permission-target'))
    const racedRm = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
    const out = await deleteTreeEntry(plainDir, 'no-permission-target', true, racedRm)
    expect(out).toEqual({ ok: false, reason: 'no-permission' })
  })

  describe('a concurrently-shrinking folder is never reported not-found while it is still there', () => {
    test('rm throwing ENOENT for a raced child does not read back as not-found when the entry survives', async () => {
      mkdirSync(join(plainDir, 'race-enoent'))
      writeFileSync(join(plainDir, 'race-enoent', 'still-here.txt'), 'x')
      const racedRm = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
      const out = await deleteTreeEntry(plainDir, 'race-enoent', true, racedRm)
      expect(out).toEqual({ ok: false, reason: 'not-empty' })
      expect(existsSync(join(plainDir, 'race-enoent'))).toBe(true)
    })

    test('rm throwing ENOTEMPTY when the entry genuinely finished being removed still answers not-found', async () => {
      mkdirSync(join(plainDir, 'race-gone'))
      // The injected `rm` stands in for a concurrent actor that finished removing the whole entry
      // and only then reported ENOTEMPTY — so the recheck's own `lstat` must find nothing real.
      const racedRm = async (target: string) => {
        rmSync(target, { recursive: true, force: true })
        throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' })
      }
      const out = await deleteTreeEntry(plainDir, 'race-gone', true, racedRm as never)
      expect(out).toEqual({ ok: false, reason: 'not-found' })
      expect(existsSync(join(plainDir, 'race-gone'))).toBe(false)
    })
  })
})

describe('searchTree', () => {
  test('finds a filename match', async () => {
    const out = await searchTree(gitRepo, 'README')
    expect(out.hits).toContainEqual({ kind: 'name', path: 'README.md' })
  })

  test('finds a content match inside a git repo, and NEVER inside the gitignored file', async () => {
    const out = await searchTree(gitRepo, 'should not appear')
    expect(out.hits.some(h => h.kind === 'content')).toBe(false)
  })

  test('finds a content match in a TRACKED file', async () => {
    const out = await searchTree(gitRepo, 'export const a')
    expect(out.hits).toContainEqual({ kind: 'content', path: 'src/a.ts', line: 1, text: 'export const a = 1' })
  })

  test('finds a content match in an UNTRACKED (but not ignored) file too', async () => {
    const out = await searchTree(gitRepo, 'export const b')
    expect(out.hits).toContainEqual({ kind: 'content', path: 'src/untracked.ts', line: 1, text: 'export const b = 2' })
  })

  test('an empty query returns nothing rather than the whole tree', async () => {
    const out = await searchTree(gitRepo, '  ')
    expect(out.hits).toEqual([])
  })

  test('search works in a non-git directory too, bounded, without hanging', async () => {
    const out = await searchTree(plainDir, 'x')
    expect(out.hits.some(h => h.kind === 'name' && h.path === 'x.txt')).toBe(true)
  })

  test('a file above the plain-grep size cap is skipped, a smaller sibling still matches — and the result is reported PARTIAL', async () => {
    const heavyDir = join(plainDir, 'heavyfile')
    mkdirSync(heavyDir)
    // Comfortably above the module's 1 MiB cap regardless of its exact value.
    writeFileSync(join(heavyDir, 'big.txt'), `${'x'.repeat(2_000_000)}findme-big\n`)
    writeFileSync(join(heavyDir, 'small.txt'), 'findme-small\n')

    const out = await searchTree(heavyDir, 'findme')
    expect(out.hits.some(h => h.kind === 'content' && h.path === 'small.txt')).toBe(true)
    expect(out.hits.some(h => h.kind === 'content' && h.path === 'big.txt')).toBe(false)
    // A file was skipped for its size, never even opened to check for a match — the scan did not
    // cover the whole tree, so the "complete" wording must not be shown over it.
    expect(out.truncated).toBe(true)
  })

  test('the plain walk stopping at its file cap is reported as a PARTIAL result, not a complete one', async () => {
    const heavyRoot = join(plainDir, 'walk-cap-dir')
    mkdirSync(heavyRoot)
    for (let i = 0; i < 6; i++) writeFileSync(join(heavyRoot, `f${i}.txt`), 'irrelevant\n')

    // Overriding the walk's own file cap to a tiny number is what makes this reproducible without
    // building PLAIN_WALK_FILE_LIMIT (5000) real files on disk — same arithmetic, smaller fixture.
    const out = await searchTree(heavyRoot, 'f', { fileLimit: 3 })
    expect(out.hits.length).toBeGreaterThan(0)
    expect(out.truncated).toBe(true)
  })

  test('the plain grep stopping AT the hit cap is reported as PARTIAL, even when the final count lands exactly on the limit', async () => {
    // This is the exact defect: `capHits` only sees `hits.length > limit`, so a grep that broke
    // off internally at EXACTLY the cap (never producing anything for `capHits` to slice) read as
    // complete. `grepLimit` overrides the module's own `SEARCH_LIMIT` so the boundary can be
    // reproduced with a handful of files instead of 200 real ones.
    const boundaryDir = join(plainDir, 'grep-boundary-dir')
    mkdirSync(boundaryDir)
    for (let i = 0; i < 5; i++) writeFileSync(join(boundaryDir, `g${i}.txt`), 'needle\n')

    const out = await searchTree(boundaryDir, 'needle', { grepLimit: 2 })
    expect(out.hits).toHaveLength(2)
    expect(out.truncated).toBe(true)
  })

  test('a plain grep that finishes within its cap after scanning everything is reported COMPLETE', async () => {
    const smallDir = join(plainDir, 'grep-complete-dir')
    mkdirSync(smallDir)
    writeFileSync(join(smallDir, 'one.txt'), 'needle\n')
    writeFileSync(join(smallDir, 'two.txt'), 'no match here\n')

    const out = await searchTree(smallDir, 'needle', { grepLimit: 200 })
    expect(out.hits).toHaveLength(1)
    expect(out.truncated).toBe(false)
  })

  test('a genuine git grep failure falls back to a plain content read instead of reporting no matches', async () => {
    // `[` is an invalid regex to `git grep -e` (unbalanced bracket) and exits >1 with empty
    // stdout — a real failure, not the exit-1 "ran fine, found nothing" case. The plain fallback
    // matches it as a literal substring instead.
    mkdirSync(join(gitRepo, 'brackets'))
    writeFileSync(join(gitRepo, 'brackets', 'arr.ts'), 'export const arr = [1, 2]\n')
    git(gitRepo, 'add', 'brackets/arr.ts')
    git(gitRepo, 'commit', '-q', '-m', 'add brackets fixture')

    const out = await searchTree(gitRepo, '[')
    expect(out.hits).toContainEqual({ kind: 'content', path: 'brackets/arr.ts', line: 1, text: 'export const arr = [1, 2]' })
  })

  test('exit 1 ("ran fine, no matches") is answered with no content hits, never a fallback', async () => {
    // Reuses the existing gitignored-file fixture: `git grep` genuinely finds nothing for this
    // query (the only file containing it is excluded by `.gitignore`), which is exit 1 — the
    // plain fallback must NOT kick in and surface the ignored file's content.
    const out = await searchTree(gitRepo, 'should not appear')
    expect(out.hits.some(h => h.kind === 'content')).toBe(false)
  })
})

describe('walkPlain', () => {
  test('a directory-heavy, nearly file-free tree stops once the directory cap is hit', async () => {
    const heavyRoot = join(root, 'dirheavy')
    mkdirSync(heavyRoot)
    const totalDirs = 12
    for (let i = 0; i < totalDirs; i++) {
      const d = join(heavyRoot, `d${i}`)
      mkdirSync(d)
      writeFileSync(join(d, 'marker.txt'), String(i))
    }

    const dirLimit = 5
    const { files, truncated } = await walkPlain(heavyRoot, { dirLimit })

    // The root itself is the first directory visited, leaving `dirLimit - 1` children walked —
    // deterministic regardless of `readdir`'s own ordering, since every child holds exactly one
    // file. This is the proof the FILE cap alone could never give: none of these directories
    // holds more than one file each, so `PLAIN_WALK_FILE_LIMIT` (5000) would never fire here —
    // only the independent directory cap stops the walk.
    expect(files.length).toBe(dirLimit - 1)
    expect(files.length).toBeLessThan(totalDirs)
    expect(truncated).toBe(true)
  })

  test('a tree smaller than the directory cap is walked completely', async () => {
    const smallRoot = join(root, 'dirsmall')
    mkdirSync(smallRoot)
    for (let i = 0; i < 3; i++) {
      const d = join(smallRoot, `d${i}`)
      mkdirSync(d)
      writeFileSync(join(d, 'marker.txt'), String(i))
    }
    const { files, truncated } = await walkPlain(smallRoot, { dirLimit: 5 })
    expect(files).toHaveLength(3)
    expect(truncated).toBe(false)
  })

  test('the file cap alone stops the walk and is reported truncated', async () => {
    const manyRoot = join(root, 'manyfiles')
    mkdirSync(manyRoot)
    for (let i = 0; i < 6; i++) writeFileSync(join(manyRoot, `f${i}.txt`), String(i))
    const { files, truncated } = await walkPlain(manyRoot, { fileLimit: 3 })
    expect(files.length).toBe(3)
    expect(truncated).toBe(true)
  })
})
