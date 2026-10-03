import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forbiddenPath, planViewedRead, readPathsFromTurns } from './viewed-file'

const DATA = '/home/u/.agentistics'
const ok = (p: string, named = p) => ({ named, real: p })

describe('planViewedRead', () => {
  test('a file the transcript read, anywhere, is allowed', () => {
    const p = '/home/u/.agentistics/leader/shots/v2981/fido2-error.png'
    const r = planViewedRead({ path: p, asked: p, allowed: [ok(p)], dataDir: DATA })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.type.mime).toBe('image/png')
  })
  test('a file the transcript never named is refused, however innocent', () => {
    const r = planViewedRead({ path: '/x/other.png', asked: '/x/other.png', allowed: [ok('/x/a.png')], dataDir: DATA })
    expect(r).toEqual({ ok: false, reason: 'not-in-transcript' })
  })
  test('the vault and key material are refused even when read', () => {
    for (const p of [`${DATA}/vault/shot.png`, '/h/a.sealed', '/h/id_rsa', '/h/.ssh/x.png', '/h/key.pem']) {
      expect(forbiddenPath(p, DATA)).toBe(true)
    }
    const v = `${DATA}/vault/x.png`
    expect(planViewedRead({ path: v, asked: v, allowed: [ok(v)], dataDir: DATA })).toEqual({ ok: false, reason: 'forbidden' })
  })
  test('wrong mime: text, html and svg are refused', () => {
    for (const p of ['/x/a.txt', '/x/a.html', '/x/a.svg', '/x/noext']) {
      expect(planViewedRead({ path: p, asked: p, allowed: [ok(p)], dataDir: DATA })).toEqual({ ok: false, reason: 'wrong-type' })
    }
  })
  test('pdf and video are served', () => {
    for (const p of ['/x/a.pdf', '/x/a.mp4']) expect(planViewedRead({ path: p, asked: p, allowed: [ok(p)], dataDir: DATA }).ok).toBe(true)
  })
})

describe('symlinks (real filesystem)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'viewed-')))
  mkdirSync(join(dir, 'vault'))
  writeFileSync(join(dir, 'notes.txt'), 'secret')
  writeFileSync(join(dir, 'vault', 'a.png'), 'x')
  symlinkSync(join(dir, 'notes.txt'), join(dir, 'shot.png'))
  symlinkSync(join(dir, 'vault', 'a.png'), join(dir, 'innocent.png'))
  test('an image-named link to a text file is refused (the REAL extension decides)', () => {
    const real = realpathSync(join(dir, 'shot.png'))
    const r = planViewedRead({ path: real, asked: join(dir, 'shot.png'), allowed: [{ named: join(dir, 'shot.png'), real }], dataDir: dir })
    expect(r).toEqual({ ok: false, reason: 'wrong-type' })
  })
  test('an innocent-looking link into the vault is refused (the REAL path decides)', () => {
    const real = realpathSync(join(dir, 'innocent.png'))
    const r = planViewedRead({ path: real, asked: join(dir, 'innocent.png'), allowed: [{ named: join(dir, 'innocent.png'), real }], dataDir: dir })
    expect(r).toEqual({ ok: false, reason: 'forbidden' })
  })
  test('asking for the link target directly does not match a name that pointed elsewhere', () => {
    const r = planViewedRead({ path: join(dir, 'notes.txt'), asked: join(dir, 'notes.txt'), allowed: [{ named: join(dir, 'shot.png'), real: join(dir, 'other') }], dataDir: dir })
    expect(r).toEqual({ ok: false, reason: 'not-in-transcript' })
  })
})

describe('readPathsFromTurns', () => {
  test('Read calls only, by shared vocabulary, truncated details dropped', () => {
    expect(readPathsFromTurns([{ tools: [
      { name: 'Read', detail: '/a/x.png' }, { name: 'read_file', canonical: 'Read', detail: '/a/y.png' },
      { name: 'Write', detail: '/a/z.png' }, { name: 'Read', detail: '/a/long…' },
    ] }])).toEqual(['/a/x.png', '/a/y.png'])
  })
})
