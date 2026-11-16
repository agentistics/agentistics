/**
 * The person's input onto a browser (NAVEGADOR S4, spec §1.6): parsing, the CDP it becomes, and the
 * channel that decides — on the SERVER, per event — whether the padlock lets it through.
 */
import { describe, expect, test } from 'bun:test'
import {
  MAX_EVENTS_PER_SECOND, MAX_BROWSER_TEXT, parseBrowserInput, toCdpCommands, createBrowserInputChannel,
  type BrowserInputAck, type CdpCommand,
} from './browser-input-protocol'

const vp = { w: 1280, h: 800 }

describe('parseBrowserInput', () => {
  test('a pointer press with normalized coordinates', () => {
    const r = parseBrowserInput(JSON.stringify({ seq: 1, op: 'pointer', type: 'down', x: 0.5, y: 0.25, button: 'left' }))
    expect(r).toEqual({ ok: true, msg: { seq: 1, op: 'pointer', type: 'down', x: 0.5, y: 0.25, button: 'left', clicks: 1, deltaX: 0, deltaY: 0, mods: 0 } })
  })

  test('coordinates outside the frame are refused, never clamped onto the page', () => {
    for (const [x, y] of [[-0.01, 0.5], [1.01, 0.5], [0.5, 2], [Number.NaN, 0.5]] as const) {
      const r = parseBrowserInput(JSON.stringify({ seq: 2, op: 'pointer', type: 'down', x, y, button: 'left' }))
      expect(r).toEqual({ ok: false, seq: 2, reason: 'out_of_range' })
    }
  })

  test('malformed messages are answered, never thrown', () => {
    expect(parseBrowserInput('{')).toEqual({ ok: false, seq: null, reason: 'bad_json' })
    expect(parseBrowserInput('[]')).toEqual({ ok: false, seq: null, reason: 'bad_message' })
    expect(parseBrowserInput(JSON.stringify({ op: 'text', text: 'a' }))).toEqual({ ok: false, seq: null, reason: 'bad_message' })
    expect(parseBrowserInput(JSON.stringify({ seq: 3, op: 'nope' }))).toEqual({ ok: false, seq: 3, reason: 'bad_message' })
    expect(parseBrowserInput(JSON.stringify({ seq: 4, op: 'pointer', type: 'drag', x: 0, y: 0 }))).toEqual({ ok: false, seq: 4, reason: 'bad_message' })
    expect(parseBrowserInput(JSON.stringify({ seq: 5, op: 'pointer', type: 'down', x: 0, y: 0, button: 'back' }))).toEqual({ ok: false, seq: 5, reason: 'bad_message' })
  })

  test('text: empty and too long are refused', () => {
    expect(parseBrowserInput(JSON.stringify({ seq: 1, op: 'text', text: '' }))).toEqual({ ok: false, seq: 1, reason: 'empty_text' })
    expect(parseBrowserInput(JSON.stringify({ seq: 1, op: 'text', text: 'x'.repeat(MAX_BROWSER_TEXT + 1) }))).toEqual({ ok: false, seq: 1, reason: 'text_too_long' })
    expect(parseBrowserInput(JSON.stringify({ seq: 1, op: 'text', text: 'olá' }))).toEqual({ ok: true, msg: { seq: 1, op: 'text', text: 'olá' } })
  })

  test('key: bounded names, at most one character of text', () => {
    expect(parseBrowserInput(JSON.stringify({ seq: 1, op: 'key', type: 'down', key: 'Enter', code: 'Enter' }))).toMatchObject({ ok: true })
    expect(parseBrowserInput(JSON.stringify({ seq: 1, op: 'key', type: 'down', key: 'x'.repeat(40), code: 'KeyX' }))).toEqual({ ok: false, seq: 1, reason: 'bad_message' })
    expect(parseBrowserInput(JSON.stringify({ seq: 1, op: 'key', type: 'down', key: 'a', code: 'KeyA', text: 'abc' }))).toEqual({ ok: false, seq: 1, reason: 'bad_message' })
    expect(parseBrowserInput(JSON.stringify({ seq: 1, op: 'key', type: 'press', key: 'a', code: 'KeyA' }))).toEqual({ ok: false, seq: 1, reason: 'bad_message' })
  })

  test('wheel deltas are bounded', () => {
    expect(parseBrowserInput(JSON.stringify({ seq: 1, op: 'pointer', type: 'wheel', x: 0.1, y: 0.1, deltaY: 1e9 }))).toEqual({ ok: false, seq: 1, reason: 'out_of_range' })
  })
})

describe('toCdpCommands', () => {
  test('normalized → viewport pixels; press and release are mouse events', () => {
    const p = parseBrowserInput(JSON.stringify({ seq: 1, op: 'pointer', type: 'down', x: 0.5, y: 0.25, button: 'left', mods: 8 }))
    if (!p.ok) throw new Error('parse')
    expect(toCdpCommands(p.msg, vp)).toEqual([{ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 640, y: 200, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 } }])
  })

  test('a wheel is a mouseWheel at the point', () => {
    const p = parseBrowserInput(JSON.stringify({ seq: 1, op: 'pointer', type: 'wheel', x: 0, y: 1, deltaY: 120 }))
    if (!p.ok) throw new Error('parse')
    expect(toCdpCommands(p.msg, vp)).toEqual([{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 0, y: 800, button: 'none', buttons: 0, clickCount: 0, modifiers: 0, deltaX: 0, deltaY: 120 } }])
  })

  test('a printable key types its text; a named key carries its virtual key code', () => {
    const a = parseBrowserInput(JSON.stringify({ seq: 1, op: 'key', type: 'down', key: 'a', code: 'KeyA', text: 'a' }))
    const enter = parseBrowserInput(JSON.stringify({ seq: 2, op: 'key', type: 'down', key: 'Enter', code: 'Enter' }))
    const bs = parseBrowserInput(JSON.stringify({ seq: 3, op: 'key', type: 'up', key: 'Backspace', code: 'Backspace' }))
    if (!a.ok || !enter.ok || !bs.ok) throw new Error('parse')
    expect(toCdpCommands(a.msg, vp)).toEqual([{ method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', unmodifiedText: 'a', windowsVirtualKeyCode: 65, modifiers: 0 } }])
    expect(toCdpCommands(enter.msg, vp)).toEqual([{ method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, modifiers: 0 } }])
    expect(toCdpCommands(bs.msg, vp)).toEqual([{ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0 } }])
  })

  test('text is inserted as text', () => {
    const t = parseBrowserInput(JSON.stringify({ seq: 1, op: 'text', text: 'senha' }))
    if (!t.ok) throw new Error('parse')
    expect(toCdpCommands(t.msg, vp)).toEqual([{ method: 'Input.insertText', params: { text: 'senha' } }])
  })
})

function channel(opts: { allowed?: () => boolean; dispatch?: (c: CdpCommand[]) => Promise<boolean>; viewport?: () => Promise<{ w: number; h: number } | null> } = {}) {
  const acks: BrowserInputAck[] = []
  const sent: CdpCommand[][] = []
  let now = 5_000
  let inputs = 0
  const ch = createBrowserInputChannel({
    allowed: opts.allowed ?? (() => true),
    viewport: opts.viewport ?? (async () => vp),
    dispatch: opts.dispatch ?? (async (c) => { sent.push(c); return true }),
    noteInput: () => { inputs++ },
    emit: (a) => { acks.push(a) },
    now: () => now,
  })
  return { ch, acks, sent, inputs: () => inputs, tick: (ms: number) => { now += ms } }
}

const settle = () => new Promise(r => setTimeout(r, 5))
const down = (seq: number) => JSON.stringify({ seq, op: 'pointer', type: 'down', x: 0.1, y: 0.1, button: 'left' })

describe('the input channel', () => {
  test('LOCKED (the model drives): every event is refused with ack locked and nothing reaches the page', async () => {
    const c = channel({ allowed: () => false })
    c.ch.submit(down(1))
    c.ch.submit(JSON.stringify({ seq: 2, op: 'text', text: 'segredo' }))
    c.ch.submit(JSON.stringify({ seq: 3, op: 'key', type: 'down', key: 'Enter', code: 'Enter' }))
    await settle()
    expect(c.acks).toEqual([{ seq: 1, ok: false, reason: 'locked' }, { seq: 2, ok: false, reason: 'locked' }, { seq: 3, ok: false, reason: 'locked' }])
    expect(c.sent).toEqual([])
    expect(c.inputs()).toBe(0)
  })

  test('the padlock is read at EACH event, not at connect', async () => {
    let unlocked = true
    const c = channel({ allowed: () => unlocked })
    c.ch.submit(down(1))
    await settle()
    unlocked = false
    c.ch.submit(down(2))
    await settle()
    expect(c.acks).toEqual([{ seq: 1, ok: true }, { seq: 2, ok: false, reason: 'locked' }])
    expect(c.sent.length).toBe(1)
  })

  test('S4b (QA Q-M2): the person hands the browser back WHILE the viewport is read → the event is refused, nothing reaches the page', async () => {
    let unlocked = true
    const c = channel({ allowed: () => unlocked, viewport: async () => { unlocked = false; return vp } })
    c.ch.submit(down(1))
    c.ch.submit(JSON.stringify({ seq: 2, op: 'text', text: 'segredo' }))
    await settle()
    expect(c.acks).toEqual([{ seq: 1, ok: false, reason: 'locked' }, { seq: 2, ok: false, reason: 'locked' }])
    expect(c.sent).toEqual([])
    expect(c.inputs()).toBe(0)
  })

  test('unlocked: one ack per event, in order, and the person\'s input is noted (auto-lock clock)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const order: number[] = []
    const c = channel({ dispatch: async (cmds) => { const x = cmds[0]!.params.x as number; if (x === 128) await gate; order.push(x); return true } })
    c.ch.submit(down(1))
    c.ch.submit(JSON.stringify({ seq: 2, op: 'pointer', type: 'up', x: 0.2, y: 0.1, button: 'left' }))
    await settle()
    expect(order).toEqual([]) // the second waits for the first: FIFO
    release()
    await settle()
    expect(order).toEqual([128, 256])
    expect(c.acks).toEqual([{ seq: 1, ok: true }, { seq: 2, ok: true }])
    expect(c.inputs()).toBe(2)
  })

  test('a failed dispatch is a failed ack and the next event still runs', async () => {
    let n = 0
    const c = channel({ dispatch: async () => { n++; if (n === 1) throw new Error('cdp'); return true } })
    c.ch.submit(down(1)); c.ch.submit(down(2))
    await settle()
    expect(c.acks).toEqual([{ seq: 1, ok: false, reason: 'send_failed' }, { seq: 2, ok: true }])
  })

  test('no browser/viewport: refused in words', async () => {
    const c = channel({ viewport: async () => null })
    c.ch.submit(down(1))
    c.ch.submit(JSON.stringify({ seq: 2, op: 'text', text: 'a' }))
    await settle()
    expect(c.acks).toEqual([{ seq: 1, ok: false, reason: 'no_browser' }, { seq: 2, ok: false, reason: 'no_browser' }])
  })

  test('a flood is rate limited', async () => {
    const c = channel()
    for (let i = 1; i <= MAX_EVENTS_PER_SECOND + 5; i++) c.ch.submit(down(i))
    await settle()
    expect(c.acks.filter(a => a.ok).length).toBe(MAX_EVENTS_PER_SECOND)
    expect(c.acks.filter(a => !a.ok && a.reason === 'rate_limited').length).toBe(5)
    c.tick(1001)
    c.ch.submit(down(999))
    await settle()
    expect(c.acks.at(-1)).toEqual({ seq: 999, ok: true })
  })
})
