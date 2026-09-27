/**
 * integrations/opencode/fixture-db.ts — TEST SUPPORT. Turns the committed, redacted
 * `__fixtures__/sessions.json` (structural fields only: numeric tokens/timestamps, tool names,
 * synthetic model ids; every path/command replaced with a `<redacted-…>` placeholder) into a
 * throwaway real SQLite database with the exact `session`/`message`/`part` shape `index.ts` and
 * `differential-opencode.ts` read — never a binary blob committed to the repo (CLAUDE.md step 18).
 *
 * The tables here carry only the columns those two readers actually SELECT — a MINIMAL schema, the
 * same choice `antigravity/fixture-db.ts` makes for `gen_metadata` rather than reproducing every
 * column of the real (much wider) production table.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Database } from 'bun:sqlite'

export interface FixtureSession {
  id: string
  directory: string
  version: string
  time_created: number
}

export interface FixtureMessage {
  id: string
  time_created: number
  role: 'user' | 'assistant'
  modelID?: string
  finish?: string
  error?: { name: string }
  time?: { created?: number; completed?: number }
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  cost?: number
}

export interface FixturePart {
  id: string
  message_id: string
  time_created: number
  time_updated: number
  tool: string
  status: string
  command?: string
  filePath?: string
  time?: { start?: number; end?: number }
}

export interface FixtureFile {
  sessions: FixtureSession[]
  messages: Record<string, FixtureMessage[]>
  parts: Record<string, FixturePart[]>
}

function messageData(m: FixtureMessage): string {
  if (m.role === 'user') {
    return JSON.stringify({ role: 'user', time: { created: m.time?.created ?? m.time_created } })
  }
  return JSON.stringify({
    role: 'assistant',
    time: m.time ?? { created: m.time_created },
    ...(m.modelID ? { modelID: m.modelID } : {}),
    ...(m.tokens ? { tokens: m.tokens } : {}),
    ...(m.cost !== undefined ? { cost: m.cost } : {}),
    ...(m.finish ? { finish: m.finish } : {}),
    ...(m.error ? { error: m.error } : {}),
  })
}

function partData(p: FixturePart): string {
  const input: Record<string, unknown> = {}
  if (p.command !== undefined) input.command = p.command
  if (p.filePath !== undefined) input.filePath = p.filePath
  return JSON.stringify({
    type: 'tool', tool: p.tool, callID: `call_${p.id}`,
    state: { status: p.status, input, ...(p.time ? { time: p.time } : {}) },
  })
}

/** Loads and parses the committed fixture. Exported so a test can inspect it directly. */
export function loadFixture(path: string = join(import.meta.dir, '__fixtures__', 'sessions.json')): FixtureFile {
  return JSON.parse(readFileSync(path, 'utf-8')) as FixtureFile
}

/** Builds a fresh SQLite file from `fixture` and returns its path. The caller deletes the temp dir. */
export function buildFixtureDb(fixture: FixtureFile): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-fixture-'))
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  db.run('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, version TEXT, time_created INTEGER NOT NULL)')
  db.run('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)')
  db.run('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)')

  const insSession = db.prepare('INSERT INTO session (id, directory, version, time_created) VALUES (?, ?, ?, ?)')
  const insMessage = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
  const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')

  for (const s of fixture.sessions) {
    insSession.run(s.id, s.directory, s.version, s.time_created)
    for (const m of fixture.messages[s.id] ?? []) insMessage.run(m.id, s.id, m.time_created, messageData(m))
    for (const p of fixture.parts[s.id] ?? []) insPart.run(p.id, p.message_id, s.id, p.time_created, p.time_updated, partData(p))
  }
  db.close()
  return path
}
