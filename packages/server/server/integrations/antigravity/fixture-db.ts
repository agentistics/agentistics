/**
 * integrations/antigravity/fixture-db.ts — TEST SUPPORT. Turns a committed agy fixture (text only:
 * transcripts, `history.jsonl`, and `gen_metadata.json` holding each row's STRUCTURAL fields) into a
 * throwaway root with real `conversations/<conv>.db` files, so no binary is committed and every
 * counter a test asserts is visible in the JSON beside it.
 *
 * The encoder writes exactly the wire layout `antigravity-protobuf.ts` documents — `1.4.{1,2,3,5,9,10}`,
 * `1.9.4.{1,2}` (the call's timestamp), `1.9.10.{1,4}`, `1.19` — so a fixture row exercises the
 * legacy decoder, not a second reading of it.
 */
import { cpSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

export interface FixtureRow {
  idx: number
  sys?: number
  input?: number
  output?: number
  thinking?: number
  completion?: number
  cached?: number
  ctx?: number
  window?: number
  model?: string
  /** `[seconds, nanos]` — absent means the row carries no `1.9.4`. */
  ts?: [number, number]
}

function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  do {
    let b = v % 128
    v = Math.floor(v / 128)
    if (v > 0) b |= 0x80
    out.push(b)
  } while (v > 0)
  return out
}
const vField = (f: number, v: number): number[] => [...varint(f * 8), ...varint(v)]
const lField = (f: number, bytes: number[]): number[] => [...varint(f * 8 + 2), ...varint(bytes.length), ...bytes]
const str = (s: string): number[] => [...new TextEncoder().encode(s)]

export function encodeGenMetadata(r: FixtureRow): Uint8Array {
  const usage = [
    ...(r.sys !== undefined ? vField(1, r.sys) : []),
    ...(r.input ? vField(2, r.input) : []),
    ...(r.output ? vField(3, r.output) : []),
    ...(r.cached ? vField(5, r.cached) : []),
    ...(r.thinking ? vField(9, r.thinking) : []),
    ...(r.completion ? vField(10, r.completion) : []),
  ]
  const ctx = [...(r.ctx ? vField(1, r.ctx) : []), ...(r.window ? vField(4, r.window) : [])]
  const request = [
    ...(r.ts ? lField(4, [...vField(1, r.ts[0]), ...(r.ts[1] ? vField(2, r.ts[1]) : [])]) : []),
    ...lField(10, ctx),
  ]
  const gen = [...lField(4, usage), ...lField(9, request), ...(r.model ? lField(19, str(r.model)) : [])]
  return new Uint8Array(lField(1, gen))
}

/** A fresh copy of `srcDir` with its `gen_metadata.json` materialised as SQLite databases. */
export function buildFixtureRoot(srcDir: string): string {
  const root = mkdtempSync(join(tmpdir(), 'agy-replay-'))
  cpSync(srcDir, root, { recursive: true })
  const rows = JSON.parse(readFileSync(join(srcDir, 'gen_metadata.json'), 'utf-8')) as Record<string, FixtureRow[]>
  mkdirSync(join(root, 'conversations'), { recursive: true })
  for (const [conv, list] of Object.entries(rows)) {
    const db = new Database(join(root, 'conversations', `${conv}.db`))
    db.run('CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))')
    const ins = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
    for (const r of list) { const b = encodeGenMetadata(r); ins.run(r.idx, b, b.length) }
    db.close()
  }
  return root
}
