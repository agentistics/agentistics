import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NATIVE_NOTES_FILE, readNativeNotes, withNativeNotes, writeNativeNote } from './native-notes'

const dirs: string[] = []
const dir = async () => { const d = await mkdtemp(join(tmpdir(), 'agentistics-native-notes-')); dirs.push(d); return d }
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

describe('native session notes (the session menu\'s Note for a native row)', () => {
  test('written, read back, 0600; an empty note removes it', async () => {
    const d = await dir()
    await writeNativeNote(d, 'ses_a', '  waiting on review ')
    await writeNativeNote(d, 'ses_b', 'second')
    expect(await readNativeNotes(d)).toEqual({ ses_a: 'waiting on review', ses_b: 'second' })
    expect((await stat(join(d, NATIVE_NOTES_FILE))).mode & 0o777).toBe(0o600)
    await writeNativeNote(d, 'ses_a', '')
    expect(await readNativeNotes(d)).toEqual({ ses_b: 'second' })
  })
  test('a missing or unreadable file reads as no notes', async () => {
    const d = await dir()
    expect(await readNativeNotes(d)).toEqual({})
    await writeFile(join(d, NATIVE_NOTES_FILE), '{nope')
    expect(await readNativeNotes(d)).toEqual({})
    await writeNativeNote(d, 'ses_c', 'fresh')
    expect(JSON.parse(await readFile(join(d, NATIVE_NOTES_FILE), 'utf-8'))).toEqual({ ses_c: 'fresh' })
  })
  test('rows take their note; one the row already carries is kept', () => {
    const rows = withNativeNotes([{ id: 'ses_a' }, { id: 'ses_b', note: 'own' }, { id: 'ses_c' }], { ses_a: 'n1', ses_b: 'n2' })
    expect(rows).toEqual([{ id: 'ses_a', note: 'n1' }, { id: 'ses_b', note: 'own' }, { id: 'ses_c' }])
  })
})
