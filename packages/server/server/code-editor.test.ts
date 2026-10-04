import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraftEditor, resolveEditorCommand, stripOneTrailingNewline } from './code-editor'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
const temp = async () => { const d = await mkdtemp(join(tmpdir(), 'agt-editor-')); dirs.push(d); return d }
const passthrough = <T>(fn: () => Promise<T>) => fn()

describe('resolveEditorCommand', () => {
  test('$VISUAL wins, then $EDITOR, split on whitespace', () => {
    expect(resolveEditorCommand({ VISUAL: 'code --wait', EDITOR: 'nano' }, () => true)).toEqual({ ok: true, argv: ['code', '--wait'], source: 'VISUAL' })
    expect(resolveEditorCommand({ VISUAL: '   ', EDITOR: ' nano  -w ' }, () => true)).toEqual({ ok: true, argv: ['nano', '-w'], source: 'EDITOR' })
  })
  test('vi only when it is on the PATH; otherwise a refusal', () => {
    expect(resolveEditorCommand({}, () => true)).toEqual({ ok: true, argv: ['vi'], source: 'fallback' })
    expect(resolveEditorCommand({ EDITOR: '' }, () => false)).toEqual({ ok: false, reason: 'no-editor' })
  })
})

test('stripOneTrailingNewline removes exactly one', () => {
  expect(stripOneTrailingNewline('a\n')).toBe('a')
  expect(stripOneTrailingNewline('a\n\n')).toBe('a\n')
  expect(stripOneTrailingNewline('a\r\n')).toBe('a')
  expect(stripOneTrailingNewline('a')).toBe('a')
})

describe('createDraftEditor', () => {
  test('writes a 0600 file, reads the edit back, deletes the file', async () => {
    const dir = await temp()
    let seenMode = 0
    const edit = createDraftEditor({
      suspend: passthrough, lang: () => 'en', env: { EDITOR: 'fake-ed' }, tmpDir: dir,
      run: (argv) => {
        const f = argv.at(-1)!
        expect(argv[0]).toBe('fake-ed')
        expect(f.endsWith('.md')).toBe(true)
        seenMode = statSync(f).mode & 0o777
        expect(readFileSync(f, 'utf-8')).toBe('draft')
        writeFileSync(f, 'edited draft\n')
        return { status: 0, signal: null }
      },
    })
    const r = await edit('draft')
    expect(r).toMatchObject({ ok: true, text: 'edited draft' })
    expect(seenMode).toBe(0o600)
    expect(readdirSync(dir)).toEqual([])
  })

  test('a non-zero exit leaves the draft unchanged, in words, and still deletes the file', async () => {
    const dir = await temp()
    const edit = createDraftEditor({ suspend: passthrough, lang: () => 'en', env: { EDITOR: 'x' }, tmpDir: dir, run: () => ({ status: 3, signal: null }) })
    const r = await edit('keep me')
    expect(r).toEqual({ ok: false, sentence: 'The editor exited with 3; your draft is unchanged.' })
    expect(readdirSync(dir)).toEqual([])
  })

  test('no editor anywhere is refused naming the variables; a spawn error says it could not start', async () => {
    const none = createDraftEditor({ suspend: passthrough, lang: () => 'pt', env: {}, hasVi: () => false, run: () => ({ status: 0, signal: null }) })
    const r = await none('x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.sentence).toContain('$EDITOR')
    const dir = await temp()
    const broken = createDraftEditor({ suspend: passthrough, lang: () => 'en', env: { EDITOR: 'nope' }, tmpDir: dir, run: () => ({ status: null, signal: null, error: new Error('ENOENT') }) })
    const b = await broken('x')
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.sentence).toContain('could not be started')
    expect(existsSync(dir) && readdirSync(dir).length).toBe(0)
  })
})
