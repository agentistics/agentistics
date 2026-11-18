import { describe, expect, test } from 'bun:test'
import {
  INITIAL_BROWSER_SCREEN, browserScreenReducer, browserScreenStatus, browserWatching, parseBrowserFrame, parseBrowserGone, parseBrowserState,
} from './browserStream'
import { terminalStatus, INITIAL_TERMINAL_STATE } from './terminalStream'
import {
  MOVE_MAX_PER_SECOND, browserAckReducer, browserInputOpen, browserKeyGoesToPage, cdpModifiers, normalizePoint, pointerButton, sampleMove,
} from './terminalInput'

const frame = (seq: number, tab = 'T1') => JSON.stringify({ tab, seq, w: 1280, h: 800, jpeg: 'AAAA', url: 'http://x/', title: 'X', at: 1 })

describe('viewport epoch', () => {
  for (const [width, height, w, h, oldW, oldH] of [
    [818, 205, 1596, 400, 1314, 400],
    [348, 148, 1024, 435, 1024, 652],
    [318, 148, 1024, 477, 1024, 652],
    [348, 148, 1024, 435, 1024, 652],
  ]) {
    test(`r5: two tabs at surface ${width}x${height} paint the matching frame after the stale equal key`, () => {
      let s = browserScreenReducer(INITIAL_BROWSER_SCREEN, { type: 'connecting', viewport: { width: width!, height: height! } })
      const f = { tab: 'T2', seq: 1, epoch: 0, w: oldW!, h: oldH!, jpeg: 'AAAA', url: '', title: '', at: 1 }
      s = browserScreenReducer(s, { type: 'frame', frame: f })
      s = browserScreenReducer(s, { type: 'frame', frame: { ...f, w: w!, h: h! } })
      expect(s.frame).toMatchObject({ w, h })
    })
  }
  test('r5: the unmodified QA probe also corrects an equal key when no surface was supplied', () => {
    const f = { tab: 'T1', seq: 1, epoch: 0, w: 1024, h: 652, jpeg: '', url: '', title: '', at: 0 }
    let s = browserScreenReducer(INITIAL_BROWSER_SCREEN, { type: 'connecting' })
    s = browserScreenReducer(s, { type: 'frame', frame: f })
    s = browserScreenReducer(s, { type: 'frame', frame: { ...f, h: 435 } })
    expect(s.frame?.h).toBe(435)
  })
  test('r5: a stale first frame cannot consume fresh; same epoch/seq corrects 652 to 435', () => {
    let s = browserScreenReducer(INITIAL_BROWSER_SCREEN, { type: 'connecting', viewport: { width: 348, height: 148 } })
    const f = { tab: 'T1', seq: 1, epoch: 0, w: 1024, h: 652, jpeg: 'AAAA', url: '', title: '', at: 1 }
    s = browserScreenReducer(s, { type: 'frame', frame: f })
    expect(s.fresh).toBe(true)
    s = browserScreenReducer(s, { type: 'frame', frame: { ...f, h: 435 } })
    expect(s.frame?.h).toBe(435)
    expect(s.fresh).toBe(false)
  })
  test('r5: equal keys prefer the frame that matches the current viewport, even if an old frame is displayed', () => {
    const f = { tab: 'T1', seq: 1, epoch: 0, w: 1024, h: 652, jpeg: 'AAAA', url: '', title: '', at: 1 }
    const s = { ...INITIAL_BROWSER_SCREEN, phase: 'streaming' as const, fresh: false, frame: f, viewport: { width: 348, height: 148 } }
    const good = browserScreenReducer(s, { type: 'frame', frame: { ...f, h: 435 } })
    expect(good.frame?.h).toBe(435)
    expect(browserScreenReducer(good, { type: 'frame', frame: f })).toBe(good)
  })
  test('r5: epoch takes precedence over sequence', () => {
    const f = { tab: 'T1', seq: 99, epoch: 2, w: 1024, h: 435, jpeg: 'AAAA', url: '', title: '', at: 1 }
    let s = browserScreenReducer(INITIAL_BROWSER_SCREEN, { type: 'frame', frame: f })
    s = browserScreenReducer(s, { type: 'frame', frame: { ...f, seq: 1, epoch: 3 } })
    expect(s.frame?.epoch).toBe(3)
    s = browserScreenReducer(s, { type: 'connecting' })
    const stale = browserScreenReducer(s, { type: 'frame', frame: { ...f, seq: 100, epoch: 2 } })
    expect(stale.fresh).toBe(true)
    expect(stale.frame?.epoch).toBe(3)
    const oldSequence = browserScreenReducer(s, { type: 'frame', frame: { ...f, seq: 0, epoch: 3 } })
    expect(oldSequence.fresh).toBe(true)
    expect(oldSequence.frame?.seq).toBe(1)
  })
  const ef = (seq: number, epoch: number) => ({ tab: 'T1', seq, epoch, w: 1596, h: 400, jpeg: 'AAAA', url: '', title: '', at: 1 })
  test('the epoch is parsed when the server sends it and absent otherwise', () => {
    expect(parseBrowserFrame(JSON.stringify(ef(1, 3)))?.epoch).toBe(3)
    expect(parseBrowserFrame(frame(1))?.epoch).toBeUndefined()
  })
  test('a frame of an older epoch never replaces one of a newer epoch on the same connection', () => {
    let s = browserScreenReducer(INITIAL_BROWSER_SCREEN, { type: 'connecting' })
    s = browserScreenReducer(s, { type: 'frame', frame: ef(5, 2) })
    const kept = browserScreenReducer(s, { type: 'frame', frame: ef(9, 1) })
    expect(kept.frame?.epoch).toBe(2)
    expect(browserScreenReducer(s, { type: 'frame', frame: ef(6, 2) }).frame?.seq).toBe(6)
  })
})

describe('browser stream events', () => {
  test('frame, state, gone parse; junk is null', () => {
    expect(parseBrowserFrame(frame(3))).toMatchObject({ tab: 'T1', seq: 3, w: 1280, jpeg: 'AAAA' })
    expect(parseBrowserFrame('{"tab":"T1"}')).toBeNull()
    expect(parseBrowserFrame('nope')).toBeNull()
    const st = parseBrowserState(JSON.stringify({ tab: 'T1', activeTab: 'T1', lock: 'unlocked', url: 'u', title: 't', loading: true, tabs: [{ id: 'T1', title: 't', active: true }, { nope: 1 }], lastAction: { kind: 'click', label: 'Entrar', x: 10, y: 20, at: 5 } }))
    expect(st).toMatchObject({ lock: 'unlocked', loading: true, tabs: [{ id: 'T1' }], lastAction: { kind: 'click', label: 'Entrar', x: 10, y: 20 } })
    expect(parseBrowserState(JSON.stringify({ tab: 'T1', lock: 'open' }))).toBeNull()
    expect(parseBrowserGone('{"reason":"idle"}')).toBe('idle')
  })
})

describe('the screen view-model and its honesty line', () => {
  test('connecting → streaming → gone keeps the last picture and says why', () => {
    let s = browserScreenReducer(INITIAL_BROWSER_SCREEN, { type: 'connecting' })
    expect(browserScreenStatus(s, 'pt').tone).toBe('connecting')
    s = browserScreenReducer(s, { type: 'frame', frame: parseBrowserFrame(frame(1))! })
    expect(browserScreenStatus(s, 'en')).toMatchObject({ tone: 'live', label: 'Live', showCursor: false })
    s = browserScreenReducer(s, { type: 'gone', reason: 'idle' })
    expect(s.frame).not.toBeNull()
    expect(browserScreenStatus(s, 'pt').detail).toBe('O navegador foi encerrado por ficar parado. A imagem abaixo é a última.')
  })

  test('not watching (scrolled away): the picture is frozen and SAID to be', () => {
    let s = browserScreenReducer(INITIAL_BROWSER_SCREEN, { type: 'frame', frame: parseBrowserFrame(frame(1))! })
    s = browserScreenReducer(s, { type: 'watching', watching: false })
    expect(browserScreenStatus(s, 'pt')).toMatchObject({ label: 'Parado', detail: 'Parado — role até aqui para ver ao vivo.' })
  })

  test('an older frame never replaces a newer one; a stall never blanks a picture', () => {
    let s = browserScreenReducer(INITIAL_BROWSER_SCREEN, { type: 'frame', frame: parseBrowserFrame(frame(5))! })
    s = browserScreenReducer(s, { type: 'frame', frame: parseBrowserFrame(frame(4))! })
    expect(s.frame!.seq).toBe(5)
    expect(browserScreenReducer(s, { type: 'stall' })).toBe(s)
    expect(browserScreenReducer({ ...INITIAL_BROWSER_SCREEN, phase: 'connecting' }, { type: 'stall' }).phase).toBe('stalled')
  })

  test('a NEW connection (resize, second tab) restarts seq: its first frame is shown even when its seq is lower', () => {
    let s = browserScreenReducer(INITIAL_BROWSER_SCREEN, { type: 'frame', frame: parseBrowserFrame(frame(9))! })
    s = browserScreenReducer(s, { type: 'connecting', viewport: { width: 1596, height: 400 } })
    s = browserScreenReducer(s, { type: 'frame', frame: { ...parseBrowserFrame(frame(1))!, w: 1596, h: 400 } })
    expect(s.frame).toMatchObject({ seq: 1, w: 1596 })
    // ...and within that connection, order is enforced again
    s = browserScreenReducer(s, { type: 'frame', frame: parseBrowserFrame(frame(1))! })
    expect(s.frame!.w).toBe(1596)
  })

  test('watching needs all three: in viewport, tab visible, panel open', () => {
    expect(browserWatching({ inViewport: true, documentVisible: true, panelOpen: true })).toBe(true)
    for (const k of ['inViewport', 'documentVisible', 'panelOpen'] as const) {
      expect(browserWatching({ inViewport: true, documentVisible: true, panelOpen: true, [k]: false })).toBe(false)
    }
  })

  test('terminalStatus speaks of a browser with the browser subject (no "lines"), the old subjects untouched', () => {
    const live = { ...INITIAL_TERMINAL_STATE, phase: 'streaming' as const }
    expect(terminalStatus(live, 'en', 'browser').detail).toBe('The browser\'s current screen.')
    expect(terminalStatus(live, 'en', 'session').detail.startsWith('The agent\'s current screen')).toBe(true)
  })
})

describe('browser input (client half)', () => {
  test('the padlock decides what is offered: locked = nothing', () => {
    expect(browserInputOpen('locked')).toBe(false)
    expect(browserInputOpen('unlocked')).toBe(true)
    expect(browserInputOpen('none')).toBe(true)
  })

  test('points normalize over the picture; outside is null, never clamped', () => {
    const rect = { left: 100, top: 50, width: 640, height: 400 }
    expect(normalizePoint(420, 250, rect)).toEqual({ x: 0.5, y: 0.5 })
    expect(normalizePoint(99, 250, rect)).toBeNull()
    expect(normalizePoint(420, 451, rect)).toBeNull()
    expect(normalizePoint(1, 1, { left: 0, top: 0, width: 0, height: 10 })).toBeNull()
  })

  test('moves: only dragging or explicit hover, at most 30 per second', () => {
    expect(sampleMove({ now: 1000, lastSentAt: 0, buttons: 0, hover: false })).toBeNull()
    expect(sampleMove({ now: 1000, lastSentAt: 0, buttons: 1, hover: false })).toBe(1000)
    expect(sampleMove({ now: 1000 + 1000 / MOVE_MAX_PER_SECOND - 1, lastSentAt: 1000, buttons: 1, hover: false })).toBeNull()
    expect(sampleMove({ now: 1000 + Math.ceil(1000 / MOVE_MAX_PER_SECOND), lastSentAt: 1000, buttons: 0, hover: true })).not.toBeNull()
  })

  test('modifiers, buttons, keys that stay with the app', () => {
    expect(cdpModifiers({ altKey: true, ctrlKey: true, metaKey: false, shiftKey: true })).toBe(11)
    expect([0, 1, 2, 3].map(pointerButton)).toEqual(['left', 'middle', 'right', 'none'])
    expect(browserKeyGoesToPage({ key: 'a', ctrlKey: false, metaKey: false, shiftKey: false })).toBe(true)
    expect(browserKeyGoesToPage({ key: 'P', ctrlKey: true, metaKey: false, shiftKey: true })).toBe(false)
    expect(browserKeyGoesToPage({ key: 'c', ctrlKey: false, metaKey: true, shiftKey: false })).toBe(false)
    expect(browserKeyGoesToPage({ key: 'a', ctrlKey: false, metaKey: false, shiftKey: false, isComposing: true })).toBe(false)
  })

  test('acks: in flight counted, the last refusal kept until an ok', () => {
    let s = browserAckReducer({ inFlight: 0, lastRefusal: null }, { type: 'sent' })
    s = browserAckReducer(s, { type: 'ack', ok: false, reason: 'locked' })
    expect(s).toEqual({ inFlight: 0, lastRefusal: 'locked' })
    s = browserAckReducer(browserAckReducer(s, { type: 'sent' }), { type: 'ack', ok: true })
    expect(s).toEqual({ inFlight: 0, lastRefusal: null })
  })
})
