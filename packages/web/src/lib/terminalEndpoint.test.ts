import { describe, expect, it, test } from 'bun:test'
import { inputWsUrl, streamUrl, type TerminalScope } from './terminalEndpoint'

describe('a scope decides which route a terminal talks to', () => {
  it('a fleet id reads the fleet stream', () => {
    expect(streamUrl('fleet', 'abc')).toBe('/api/fleet/stream?id=abc')
  })

  it('a shell id reads the SHELL stream, never the fleet one', () => {
    // The whole isolation argument, at the client end: a shell is not a fleet row, so a shell id
    // must never be offered to a route that resolves against `managed-sessions.json`.
    expect(streamUrl('shell', 'abc')).toBe('/api/shell/stream?id=abc')
    expect(streamUrl('shell', 'abc')).not.toContain('/api/fleet')
  })

  it('the id is encoded, so it can never smuggle a second query parameter', () => {
    expect(streamUrl('shell', 'a&b=c')).toBe('/api/shell/stream?id=a%26b%3Dc')
  })

  it('the write channel mirrors the read channel, scope for scope', () => {
    expect(inputWsUrl('fleet', 'abc', 'http:', 'host:1')).toBe('ws://host:1/api/fleet/input?id=abc')
    expect(inputWsUrl('shell', 'abc', 'http:', 'host:1')).toBe('ws://host:1/api/shell/input?id=abc')
  })

  it('https becomes wss', () => {
    expect(inputWsUrl('shell', 'x', 'https:', 'h')).toBe('wss://h/api/shell/input?id=x')
  })

  it('every scope has both halves', () => {
    const scopes: TerminalScope[] = ['fleet', 'shell']
    for (const s of scopes) {
      expect(streamUrl(s, 'i')).toStartWith('/api/')
      expect(inputWsUrl(s, 'i', 'http:', 'h')).toStartWith('ws://')
    }
  })
})

describe('the geometry a stream may open with', () => {
  test('is absent unless the caller has one', () => {
    expect(streamUrl('shell', 's1')).toBe('/api/shell/stream?id=s1')
  })

  test('rides the stream URL, so the pane is already the right size on the FIRST frame', () => {
    // Without it the first capture is whatever width the pane was left at by the last viewer, and
    // the band visibly snaps a moment later. The numbers are the box's own last measurement.
    expect(streamUrl('shell', 's1', { cols: 144, rows: 13 }))
      .toBe('/api/shell/stream?id=s1&cols=144&rows=13')
  })

  test('a geometry that is not a pair of positive whole numbers is left off entirely', () => {
    for (const g of [
      { cols: 0, rows: 13 }, { cols: 144, rows: 0 },
      { cols: -1, rows: 13 }, { cols: 1.5, rows: 13 },
      { cols: Number.NaN, rows: 13 }, { cols: 144, rows: Number.POSITIVE_INFINITY },
    ]) {
      expect(streamUrl('shell', 's1', g), JSON.stringify(g)).toBe('/api/shell/stream?id=s1')
    }
  })
})
