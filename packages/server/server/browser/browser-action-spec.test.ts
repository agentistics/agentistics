import { describe, expect, test } from 'bun:test'
import {
  ACTION_KIND, EVALUATE_MAX_BYTES, PERSONAL_ACTIONS, SESSION_ACTIONS, blockSentence, evaluateResult, keyDef, ownUrl,
  parseActionArgs, truncateUtf8,
} from './browser-action-spec'

const TAB = 'A1B2C3D4E5F60718293A4B5C6D7E8F90'

describe('the action table', () => {
  test('every action is classed; the reads are exactly the ones the lock must never hold', () => {
    for (const a of SESSION_ACTIONS) expect(['action', 'read']).toContain(ACTION_KIND[a])
    expect(SESSION_ACTIONS.filter(a => ACTION_KIND[a] === 'read').sort()).toEqual(['screenshot', 'snapshot', 'tabs', 'wait_for'])
    expect(PERSONAL_ACTIONS).not.toContain('evaluate')
  })
})

describe('parseActionArgs', () => {
  test('navigate needs a url; tab must look like a target id', () => {
    expect(parseActionArgs('navigate', { url: ' http://localhost:5173/ ' })).toEqual({ ok: true, args: { action: 'navigate', url: 'http://localhost:5173/' } })
    expect(parseActionArgs('navigate', {}).ok).toBe(false)
    expect(parseActionArgs('navigate', { url: 'x'.repeat(5000) }).ok).toBe(false)
    expect(parseActionArgs('navigate', { url: 'http://a', tab: '../etc' }).ok).toBe(false)
    expect(parseActionArgs('navigate', { url: 'http://a', tab: TAB })).toEqual({ ok: true, args: { action: 'navigate', url: 'http://a', tab: TAB } })
  })

  test('click takes a ref or x,y — never neither, never junk', () => {
    expect(parseActionArgs('click', { ref: 'e12' })).toEqual({ ok: true, args: { action: 'click', ref: 'e12', button: 'left', double: false } })
    expect(parseActionArgs('click', { x: 10, y: 20, button: 'right', double: true })).toEqual({ ok: true, args: { action: 'click', x: 10, y: 20, button: 'right', double: true } })
    for (const b of [{}, { ref: '12' }, { x: 1 }, { x: -1, y: 1 }, { x: 1, y: Infinity }, { ref: 'e1', button: 'side' }]) expect(parseActionArgs('click', b).ok).toBe(false)
  })

  test('type, select, press, scroll, evaluate, wait_for validate their fields', () => {
    expect(parseActionArgs('type', { ref: 'e1', text: 'alice', submit: true }).ok).toBe(true)
    expect(parseActionArgs('type', { ref: 'e1' }).ok).toBe(false)
    expect(parseActionArgs('type', { ref: 'e1', text: 'x'.repeat(10_001) }).ok).toBe(false)
    expect(parseActionArgs('select', { ref: 'e1', values: 'red' })).toEqual({ ok: true, args: { action: 'select', ref: 'e1', values: ['red'] } })
    expect(parseActionArgs('select', { ref: 'e1', values: [] }).ok).toBe(false)
    expect(parseActionArgs('press', { key: 'Enter' }).ok).toBe(true)
    expect(parseActionArgs('press', { key: 'NotAKey' }).ok).toBe(false)
    expect(parseActionArgs('scroll', { dy: 500 })).toEqual({ ok: true, args: { action: 'scroll', dx: 0, dy: 500 } })
    expect(parseActionArgs('scroll', {}).ok).toBe(false)
    expect(parseActionArgs('scroll', { dy: 1e9 }).ok).toBe(false)
    expect(parseActionArgs('evaluate', { expression: '1+1' }).ok).toBe(true)
    expect(parseActionArgs('evaluate', { expression: ' ' }).ok).toBe(false)
    expect(parseActionArgs('wait_for', { text: 'ok' })).toEqual({ ok: true, args: { action: 'wait_for', text: 'ok', timeoutMs: 5000 } })
    expect(parseActionArgs('wait_for', { text: 'ok', ms: 5 }).ok).toBe(false)
    expect(parseActionArgs('wait_for', { ms: 20_000 }).ok).toBe(false)
    expect(parseActionArgs('wait_for', { ref: 'e3', timeoutMs: 11_000 }).ok).toBe(false)
  })

  test('snapshot mode and maxBytes; tab verbs need a tab', () => {
    expect(parseActionArgs('snapshot', {})).toEqual({ ok: true, args: { action: 'snapshot', mode: 'full' } })
    expect(parseActionArgs('snapshot', { mode: 'viewport', maxBytes: 5000 })).toEqual({ ok: true, args: { action: 'snapshot', mode: 'viewport', maxBytes: 5000 } })
    expect(parseActionArgs('snapshot', { maxBytes: 1 }).ok).toBe(false)
    expect(parseActionArgs('snapshot', { mode: 'all' }).ok).toBe(false)
    expect(parseActionArgs('tab_select', {}).ok).toBe(false)
    expect(parseActionArgs('tab_close', { tab: TAB }).ok).toBe(true)
    expect(parseActionArgs('tab_new', {})).toEqual({ ok: true, args: { action: 'tab_new' } })
  })
})

describe('keys', () => {
  test('named keys, aliases, single characters; nothing else', () => {
    expect(keyDef('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' })
    expect(keyDef('esc')).toBeNull() // aliases are exact; names are case-insensitive
    expect(keyDef('Esc')?.key).toBe('Escape')
    expect(keyDef('pagedown')?.key).toBe('PageDown')
    expect(keyDef('a')).toEqual({ key: 'a', code: 'KeyA', keyCode: 65, text: 'a' })
    expect(keyDef('7')).toEqual({ key: '7', code: 'Digit7', keyCode: 55, text: '7' })
    expect(keyDef('ç')?.text).toBe('ç')
    expect(keyDef('ab')).toBeNull()
    expect(keyDef('\u0003')).toBeNull()
  })
})

describe('results', () => {
  test('evaluate returns at most 20 KB, never splitting a character', () => {
    const r = evaluateResult('é'.repeat(30_000), 'string')
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.value, 'utf8')).toBeLessThanOrEqual(EVALUATE_MAX_BYTES)
    expect(r.value.includes('�')).toBe(false)
    expect(evaluateResult(undefined, 'undefined').value).toBe('undefined')
    expect(evaluateResult({ a: 1 }, 'object').value).toBe('{"a":1}')
    expect(truncateUtf8('abc', 10)).toEqual({ text: 'abc', truncated: false, bytes: 3 })
    expect(truncateUtf8('😀😀', 5).text).toBe('😀')
  })

  test('ownUrl drops credentials and shortens data:', () => {
    expect(ownUrl('https://u:p@a.test/x?q=1')).toBe('https://a.test/x?q=1')
    expect(ownUrl(`data:text/html,${'x'.repeat(1000)}`).length).toBeLessThan(110)
  })

  test('blockSentence names the reason and the redirect', () => {
    expect(blockSentence('agentistics-port', 'http://127.0.0.1:47291/x', 'redirect')).toMatch(/agentistics' own server port \(the page redirected there\)/)
    expect(blockSentence('scheme', 'file:///etc/passwd')).toMatch(/file:/)
  })
})
