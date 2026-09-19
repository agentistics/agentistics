/**
 * A save from the Studio leaves the bytes nobody edited ALONE — asserted over the FILE ON DISK, through
 * the path a save really takes: the server's read route -> `readRepoFile` -> a real Monaco text model
 * (the class `monaco.editor.createModel` constructs) -> Monaco's own `CodeEditorWidget.getValue` ->
 * `editorSaveText` -> `writeRepoFile` -> the server's write route -> disk.
 *
 * A string comparison would not do: the defect was a string that LOOKED right (`a\r\nb\r\n`) and
 * three bytes short. The widget cannot be imported without a DOM (its module reads
 * `mainWindow.location` at load), so its `getValue` METHOD is lifted out of Monaco's own source and
 * run against the model — the option mapping under test is Monaco's, never a restatement of it.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleEditorTreeRoute } from '../../../server/server/sessions/editor-web'
import { editorSaveText, type SaveTextSource } from './editorSaveText'
import { readRepoFile, writeRepoFile } from './repoApi'
import { stripComments } from './stripComments'

const DIR = mkdtempSync(join(tmpdir(), 'agentistics-save-bytes-'))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

// --- the server, reached through `fetch` exactly as the browser reaches it ------------------------

const host = {
  sessions: async () => ({ sessions: [{ id: 's1', conversationId: 'c1', cwd: DIR }], attention: 0, rang: [] }),
} as unknown as Parameters<typeof handleEditorTreeRoute>[2]

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(new URL(String(input), 'http://agentop.test'), init)
  const res = await handleEditorTreeRoute(req, new URL(req.url), host, 'en')
  return res ?? new Response('{}', { status: 404 })
}) as typeof fetch
afterAll(() => { globalThis.fetch = realFetch })

// --- Monaco's model and Monaco's getValue ---------------------------------------------------------

// Through a variable: Monaco ships no declarations for its internal modules, and the shape needed
// here is the two members typed below.
const TEXT_MODEL_MODULE = 'monaco-editor/editor/common/model/textModel.js'
const { TextModel } = await import(TEXT_MODEL_MODULE) as {
  TextModel: {
    new (...args: unknown[]): { getValue(eol?: number, preserveBOM?: boolean): string }
    DEFAULT_CREATION_OPTIONS: unknown
  }
}
/** Services the model's constructor asks for; plain text needs none of them to answer anything. */
const inert = { dispose() { /* nothing held */ } }
const service: unknown = new Proxy({}, {
  get: (_t, k) => (typeof k === 'string' && k.startsWith('on') ? () => inert : () => undefined),
})
const instantiation = {
  createInstance: (C: new (...a: unknown[]) => unknown, ...a: unknown[]) =>
    new C(...a, service, service, instantiation, service, service, service),
}

const WIDGET_SRC = readFileSync(
  Bun.resolveSync('monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js', import.meta.dir), 'utf8',
)
const GETVALUE_BODY = /\n {4}getValue\(options = null\) \{\n([\s\S]*?)\n {4}\}\n/.exec(WIDGET_SRC)?.[1] ?? null

/** An editor over `text`, answering `getValue` with the widget's own method body. */
function monacoEditorOver(text: string): SaveTextSource {
  const model = new TextModel(text, 'plaintext', TextModel.DEFAULT_CREATION_OPTIONS, null,
    service, service, service, instantiation)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const method = new Function('options', GETVALUE_BODY!) as (this: unknown, o?: unknown) => string
  const widget = { _modelData: { model } }
  return { getValue: (options?: unknown) => method.call(widget, options) } as SaveTextSource
}

/** Write `bytes`, open them in the Studio, save with no edit, and return what is on disk. */
async function openAndSave(name: string, bytes: Buffer, read: (e: SaveTextSource) => string = editorSaveText) {
  writeFileSync(join(DIR, name), bytes)
  const opened = await readRepoFile('s1', name, 'en')
  if (!opened.ok || 'binary' in opened) throw new Error(`open failed: ${JSON.stringify(opened)}`)
  const saved = await writeRepoFile('s1', name, read(monacoEditorOver(opened.content)), opened.mtimeMs, 'en')
  if (!saved.ok) throw new Error(`save failed: ${JSON.stringify(saved)}`)
  return readFileSync(join(DIR, name))
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

describe('a save writes back the bytes it was given', () => {
  test("Monaco's getValue was found in its own source", () => {
    expect(GETVALUE_BODY).not.toBeNull()
    expect(GETVALUE_BODY!).toContain('preserveBOM')
  })

  test('a BOM file saved with no edit is byte-identical on disk', async () => {
    const original = Buffer.concat([BOM, Buffer.from('a\r\nb\r\n')])
    expect((await openAndSave('bom-crlf.txt', original)).toString('hex')).toBe(original.toString('hex'))
    const lf = Buffer.concat([BOM, Buffer.from('export const x = 1\n')])
    expect((await openAndSave('bom-lf.ts', lf)).toString('hex')).toBe(lf.toString('hex'))
  })

  test('the defect it replaces: the bare getValue() drops the BOM from the same file', async () => {
    const original = Buffer.concat([BOM, Buffer.from('a\r\nb\r\n')])
    const bare = await openAndSave('bom-bare.txt', original, e => e.getValue())
    expect(bare.toString('hex')).toBe(Buffer.from('a\r\nb\r\n').toString('hex'))
  })

  test('a file with ONE consistent line ending, and a multibyte one, are byte-identical', async () => {
    for (const [name, bytes] of [
      ['crlf.txt', Buffer.from('one\r\ntwo\r\n')],
      ['lf.txt', Buffer.from('one\ntwo\n')],
      ['multibyte.txt', Buffer.from('é \u{1F600} 漢字 \u{1D11E} x\n')],
      ['empty.txt', Buffer.alloc(0)],
    ] as const) {
      expect((await openAndSave(name, bytes)).toString('hex')).toBe(bytes.toString('hex'))
    }
  })

  test('STATED LIMIT: mixed line endings are normalised by the model before any save runs', async () => {
    // If this starts failing, Monaco kept them: drop the limit from `editorSaveText.ts` and
    // `editor-text.ts` rather than updating the expectation.
    const out = await openAndSave('mixed.txt', Buffer.from('a\r\nb\nc\rd'))
    expect(out.toString('utf8')).toBe('a\r\nb\r\nc\r\nd')
  })
})

describe('the save reads through this module', () => {
  const EDITOR = stripComments(readFileSync(join(import.meta.dir, '../components/sessions/RepoFileEditor.tsx'), 'utf8'))
  const writeNow = (src: string) => src.slice(src.indexOf('const writeNow = async'), src.indexOf('const requestSave ='))

  test('writeNow takes its content from editorSaveText, and nothing in the editor calls getValue bare', () => {
    expect(writeNow(EDITOR)).toContain('const content = editorSaveText(editor)')
    expect(/\.getValue\(\s*\)/.test(EDITOR)).toBe(false)
  })

  test('the scan still sees the defect', () => {
    const bare = EDITOR.replace('const content = editorSaveText(editor)', 'const content = editor.getValue()')
    expect(writeNow(bare)).not.toContain('const content = editorSaveText(editor)')
    expect(/\.getValue\(\s*\)/.test(bare)).toBe(true)
  })
})
