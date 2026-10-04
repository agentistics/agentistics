/**
 * native-notes.ts — a NATIVE session's note (the session menu's "Note", like every harness's).
 *
 * A managed session keeps its note in agentop's registry; a native session has no registry record —
 * the engine owns it. Its note lives beside the registry instead, keyed by the `ses_…` id, in one
 * small file under the data dir (0600, written by rename so a crash leaves the old file whole).
 * An empty note removes the key. A missing or unreadable file reads as no notes, never a throw.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const NATIVE_NOTES_FILE = 'native-session-notes.json'

export async function readNativeNotes(dataDir: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, NATIVE_NOTES_FILE), 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch {
    return {}
  }
}

export async function writeNativeNote(dataDir: string, id: string, note: string): Promise<void> {
  const notes = await readNativeNotes(dataDir)
  const text = note.trim()
  if (text === '') delete notes[id]
  else notes[id] = text
  const file = join(dataDir, NATIVE_NOTES_FILE)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(notes, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  await rename(tmp, file)
}

/** The rows with their notes: a note the row already carries is never overwritten. */
export function withNativeNotes<R extends { id: string; note?: string }>(rows: readonly R[], notes: Record<string, string>): R[] {
  return rows.map(r => (notes[r.id] && r.note === undefined ? { ...r, note: notes[r.id]! } : r))
}
