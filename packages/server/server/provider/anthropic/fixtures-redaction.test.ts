/**
 * fixtures-redaction.test.ts — the grep over every file in the fixtures directory (spec §6.3.3
 * "Fixtures", §15 B1.5). A fixture is recorded by the owner's command, so the only way a key
 * reaches one is a recorder defect; this test is what catches it. The checker is the recorder's own
 * `assertFixtureClean`, so the gate that runs before a write is the gate tested here.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '@agentistics/core'
import { assertFixtureClean, FIXTURE_DIR, FORBIDDEN_NEEDLES } from '../../../scripts/record-anthropic-fixtures.ts'

const files = readdirSync(FIXTURE_DIR).map(name => ({ name, text: readFileSync(join(FIXTURE_DIR, name), 'utf8') }))

describe('fixtures carry no secret, no account identifier, no request-side header', () => {
  test('non-vacuity: the walk found fixtures, and the spec\'s five needles are all in the list', () => {
    expect(files.length).toBeGreaterThan(0)
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

  test('a tainted copy of a real fixture is caught (the gate is not merely never seeing anything)', () => {
    const { text } = files[0]!
    const tainted = text.replace('"headers": {', '"headers": {\n    "x-api-key": "nope",')
    expect(tainted).not.toBe(text)
    expect(() => assertFixtureClean(tainted)).toThrow('fixture refused')
  })
})
