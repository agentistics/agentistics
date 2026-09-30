/**
 * fixtures-redaction.test.ts — the grep over every file in the fixtures directory (spec §6.3.3
 * "Fixtures", §15 B1.5). A fixture is recorded by the owner's command, so the only way a key
 * reaches one is a recorder defect; this test is what catches it. The checker is `test/fixture-gate.ts`'s
 * `assertFixtureClean` — the very function the recorder runs before a write, so the gate that runs
 * before a write is the gate tested here.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '@agentistics/core'
import { assertFixtureClean, FORBIDDEN_NEEDLES } from '../../../test/fixture-gate.ts'

const FIXTURE_DIR = join(import.meta.dir, '../../../test/fixtures/provider/anthropic')

// SORTED, and pinned sorted below: `readdirSync`'s order is the filesystem's, not a contract. It
// differed between this machine and CI, and a test that read `files[0]` passed on one and failed on
// the other the moment `.sse` fixtures joined the `.json` ones.
const names = readdirSync(FIXTURE_DIR).sort()
const files = names.map(name => ({ name, text: readFileSync(join(FIXTURE_DIR, name), 'utf8') }))

/** The header every taint plants: a forbidden needle, so the gate must name it. */
const PLANTED = 'x-api-key'

/**
 * A copy of `text` with a secret-bearing header planted where that FORMAT keeps one — inside the
 * JSON `headers` object for a recorded response, as a line ahead of the first event for a recorded
 * stream. A format this cannot place a taint in THROWS: a taint that silently changes nothing is how
 * the self-test below once passed over files it never touched.
 */
function taint(name: string, text: string): string {
  if (name.endsWith('.json')) {
    const doc = JSON.parse(text) as { headers?: unknown }
    const h = doc.headers
    if (h === null || typeof h !== 'object' || Array.isArray(h)) throw new Error(`${name}: no "headers" object to plant a taint in`)
    ;(h as Record<string, unknown>)[PLANTED] = 'nope'
    return JSON.stringify(doc, null, 2)
  }
  if (name.endsWith('.sse')) {
    const lines = text.split('\n')
    const at = lines.findIndex(l => l.startsWith('event:'))
    if (at < 0) throw new Error(`${name}: no "event:" line to plant a taint ahead of`)
    lines.splice(at, 0, `: ${PLANTED}: nope`)
    return lines.join('\n')
  }
  throw new Error(`${name}: no taint is defined for this fixture format — add one before adding the fixture`)
}

describe('fixtures carry no secret, no account identifier, no request-side header', () => {
  test('non-vacuity: the walk found fixtures, and the spec\'s five needles are all in the list', () => {
    expect(files.length).toBeGreaterThan(0)
    expect(names).toEqual([...names].sort())
    for (const needle of ['sk-ant-', 'x-api-key', 'authorization', 'anthropic-organization-id']) {
      expect(FORBIDDEN_NEEDLES).toContain(needle)
    }
  })

  test('every file in the directory (any extension) passes the gate', () => {
    for (const { name, text } of files) {
      expect(() => assertFixtureClean(text), name).not.toThrow()
    }
  })

  test('every file is unchanged by redactSecrets (the redact.ts patterns find nothing)', () => {
    for (const { name, text } of files) {
      expect({ name, same: redactSecrets(text) === text }).toEqual({ name, same: true })
    }
  })

  test('self-test: the gate trips on each needle alone, in any case, and on a key-shaped value', () => {
    for (const needle of FORBIDDEN_NEEDLES) {
      expect(() => assertFixtureClean(`{"h":"${needle.toUpperCase()}x"}`)).toThrow('fixture refused')
    }
    const keyShaped = 'sk-' + 'ant-' + 'api03-' + 'A'.repeat(40)
    expect(() => assertFixtureClean(`{"body":"${keyShaped}"}`)).toThrow('fixture refused')
    expect(() => assertFixtureClean('{"body":"a perfectly ordinary message"}')).not.toThrow()
  })

  test('a tainted copy of EVERY real fixture is caught (the gate is not merely never seeing anything)', () => {
    // Both formats present, so the loop below provably exercises each taint.
    expect(names.some(n => n.endsWith('.json'))).toBe(true)
    expect(names.some(n => n.endsWith('.sse'))).toBe(true)
    for (const { name, text } of files) {
      const tainted = taint(name, text)
      expect({ name, changed: tainted !== text }).toEqual({ name, changed: true })
      expect(() => assertFixtureClean(tainted), name).toThrow(`"${PLANTED}"`)
    }
  })

  test('the taint refuses a format it cannot place a secret in, rather than changing nothing', () => {
    expect(() => taint('x.txt', 'anything')).toThrow('no taint is defined')
    expect(() => taint('x.json', '{"status": 200}')).toThrow('no "headers" object')
    expect(() => taint('x.sse', ': comment only\n')).toThrow('no "event:" line')
  })
})
