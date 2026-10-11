/**
 * session-mode-mirror.test.ts — MODE.EVERYWHERE: the four canonical modes are named twice, once in
 * `@agentistics/core` (what the web, the cockpit and the host read) and once in `@agentistics/engine-api`
 * (what a driver declares), because the contract package depends on nothing. They must stay EQUAL.
 */
import { expect, test } from 'bun:test'
import { CANONICAL_MODES as CORE, CANONICAL_MODE_TEXT } from '@agentistics/core'
import { CANONICAL_MODES as API } from '@agentistics/engine-api'

test('core and engine-api name the same canonical modes, in the same order', () => {
  expect([...CORE]).toEqual([...API])
})

test('every canonical mode has its words in both languages', () => {
  for (const m of CORE) {
    expect(CANONICAL_MODE_TEXT[m].en.label.length).toBeGreaterThan(0)
    expect(CANONICAL_MODE_TEXT[m].pt.label.length).toBeGreaterThan(0)
  }
})
