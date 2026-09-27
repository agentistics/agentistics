import { describe, expect, test } from 'bun:test'
import { OutputWindow } from './output.ts'
import { MarkerScanner, controlLine, markerPrefix, shq } from './protocol.ts'

describe('OutputWindow', () => {
  test('keeps everything under the budget', () => {
    const w = new OutputWindow(100)
    w.push('hello ')
    w.push('world')
    expect(w.drain()).toEqual({ output: 'hello world', outputTruncated: false, originalBytes: 11 })
    expect(w.drain()).toEqual({ output: '', outputTruncated: false, originalBytes: 0 })
  })

  test('keeps head and tail, says how much of the middle it cut, bounded while collecting', () => {
    const w = new OutputWindow(10)
    for (let i = 0; i < 1000; i++) w.push('0123456789')
    const t = w.drain()
    expect(t.outputTruncated).toBe(true)
    expect(t.originalBytes).toBe(10_000)
    expect(t.output.startsWith('01234')).toBe(true)
    expect(t.output.endsWith('56789')).toBe(true)
    expect(t.output).toContain('9990 bytes cut from the middle — 10000 bytes in all')
  })

  test('a smaller budget at read time narrows, never widens', () => {
    const w = new OutputWindow(100)
    w.push('a'.repeat(50) + 'b'.repeat(50))
    const t = w.peek(10)
    expect(t.output.startsWith('aaaaa')).toBe(true)
    expect(t.output.endsWith('bbbbb')).toBe(true)
    expect(t.outputTruncated).toBe(true)
  })
})

describe('MarkerScanner', () => {
  const nonce = 'ab'.repeat(16)

  test('finds the marker across arbitrary chunk boundaries and strips it', () => {
    const stream = `line one\nline two` + markerPrefix(nonce) + `3_/tmp/x\n`
    for (let cut = 1; cut < stream.length; cut++) {
      const s = new MarkerScanner(nonce)
      const a = s.push(stream.slice(0, cut))
      const b = s.push(stream.slice(cut))
      expect(a.output + b.output).toBe('line one\nline two')
      expect(a.end ?? b.end).toEqual({ status: 3, pwd: '/tmp/x' })
    }
  })

  test('a marker with another nonce is plain output', () => {
    const s = new MarkerScanner(nonce)
    const r = s.push(`${markerPrefix('cd'.repeat(16))}0_/\nafter\n`)
    expect(r.end).toBeUndefined()
    expect(r.output + s.flush()).toContain('after')
  })

  test('the control line quotes the command and restores the session only if the command did not move', () => {
    const line = controlLine(`echo 'hi'`, nonce, '/w/pkg')
    expect(line).toContain(`eval 'echo '\\''hi'\\'''`)
    expect(line).toContain(`[ "$PWD" = '/w/pkg' ] && cd -- "$__agt_prev"`)
    expect(line).toContain('3<&-')
    expect(controlLine('pwd', nonce)).not.toContain('cd --')
    expect(shq("a'b")).toBe(`'a'\\''b'`)
  })
})
