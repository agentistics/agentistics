import { afterEach, describe, expect, it } from 'bun:test'
import { clipboardPasteAvailable, pasteFromClipboard } from './clipboardPaste'

describe('clipboardPasteAvailable', () => {
  const g = globalThis as unknown as { navigator?: unknown }
  const realNavigator = g.navigator

  afterEach(() => {
    if (realNavigator === undefined) delete g.navigator; else g.navigator = realNavigator
  })

  it('true when readText exists', () => {
    g.navigator = { clipboard: { readText: async () => '' } }
    expect(clipboardPasteAvailable()).toBe(true)
  })

  it('false with no navigator at all', () => {
    delete g.navigator
    expect(clipboardPasteAvailable()).toBe(false)
  })

  it('false when clipboard exists but readText does not', () => {
    g.navigator = { clipboard: {} }
    expect(clipboardPasteAvailable()).toBe(false)
  })
})

describe('pasteFromClipboard — the strip button, and I1: a denied permission must not be silent', () => {
  const g = globalThis as unknown as { navigator?: unknown }
  const realNavigator = g.navigator

  afterEach(() => {
    if (realNavigator === undefined) delete g.navigator; else g.navigator = realNavigator
  })

  it('reads the clipboard and hands the text to sendPaste, reporting "sent"', async () => {
    g.navigator = { clipboard: { readText: async () => 'hello from the clipboard' } }
    const sent: string[] = []
    const result = await pasteFromClipboard(t => sent.push(t))
    expect(result).toBe('sent')
    expect(sent).toEqual(['hello from the clipboard'])
  })

  it('the clipboard text is sanitized before it is sent — a bracketed-paste breakout never leaves the browser', async () => {
    g.navigator = { clipboard: { readText: async () => 'a\x1b[201~touch /tmp/x\rb' } }
    const sent: string[] = []
    expect(await pasteFromClipboard(t => { sent.push(t) })).toBe('sent')
    expect(sent).toEqual(['a' + 'touch /tmp/x\rb'])
  })

  it('a clipboard that is only control bytes is an empty paste, not a send', async () => {
    g.navigator = { clipboard: { readText: async () => '\x1b\x03\x9b' } }
    const sent: string[] = []
    expect(await pasteFromClipboard(t => { sent.push(t) })).toBe('empty')
    expect(sent).toEqual([])
  })

  it('an empty clipboard sends nothing and reports "empty" — not a failure', async () => {
    g.navigator = { clipboard: { readText: async () => '' } }
    const sent: string[] = []
    const result = await pasteFromClipboard(t => sent.push(t))
    expect(result).toBe('empty')
    expect(sent).toEqual([])
  })

  it('THE I1 CASE: a denied/thrown permission sends nothing and reports "denied", never swallowed', async () => {
    // Before the fix, this outcome and an empty clipboard were the exact same thing to the caller —
    // a promise that resolves with nothing to react to. Reported live: at 390×844, with clipboard
    // permissions cleared, tapping the strip's paste button produced no visible change anywhere on
    // the page — no toast, no note, nothing. The caller must be able to tell the two apart.
    g.navigator = { clipboard: { readText: async () => { throw new DOMException('Permission denied', 'NotAllowedError') } } }
    const sent: string[] = []
    const result = await pasteFromClipboard(t => sent.push(t))
    expect(result).toBe('denied')
    expect(sent).toEqual([])
  })

  it('any other thrown reason (unsupported, revoked mid-flight) is also reported as "denied", never thrown to the caller', async () => {
    g.navigator = { clipboard: { readText: async () => { throw new Error('not supported here') } } }
    const sent: string[] = []
    await expect(pasteFromClipboard(t => sent.push(t))).resolves.toBe('denied')
    expect(sent).toEqual([])
  })
})
