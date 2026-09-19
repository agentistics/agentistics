import { describe, expect, test } from 'bun:test'
import { createShellTerminal } from './shell-terminal'
import { SHELL_SOCKET, TMUX_SOCKET } from './tmux-cli'

/** A recording fake tmux: every argv it was handed, and a scripted answer per verb. */
function fakeTmux(answers: Partial<Record<string, { code: number; out: string; err: string }>> = {}) {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    const verb = args.find(a => !a.startsWith('-') && a !== SHELL_SOCKET && a !== TMUX_SOCKET) ?? ''
    return answers[verb] ?? { code: 0, out: '', err: '' }
  }
  return { calls, run }
}

const PANE = '3\t7\t80\t24\t0\t120'

describe('every shell tmux call names the shell socket', () => {
  test('a capture does', async () => {
    const t = fakeTmux({ 'capture-pane': { code: 0, out: 'hi\n', err: '' }, 'display-message': { code: 0, out: PANE, err: '' } })
    await createShellTerminal(t.run).capture('s1', 200)
    expect(t.calls.length).toBeGreaterThan(0)
    for (const args of t.calls) expect(args.slice(0, 2)).toEqual(['-L', SHELL_SOCKET])
  })

  test('so do the two writes', async () => {
    const t = fakeTmux()
    const term = createShellTerminal(t.run)
    await term.sendText('s1', 'ls')
    await term.sendKey('s1', 'C-c')
    for (const args of t.calls) expect(args.slice(0, 2)).toEqual(['-L', SHELL_SOCKET])
    // The fleet socket is what a builder called with no argument takes — the mistake this
    // whole phase is designed around, and it would still work.
    expect(t.calls.some(a => a.includes(TMUX_SOCKET))).toBe(false)
  })

  test('so does a paste — both the set-buffer write and the paste-buffer read', async () => {
    const t = fakeTmux()
    await createShellTerminal(t.run).sendPaste('s1', 'a\nb\nc')
    expect(t.calls.length).toBe(2)
    for (const args of t.calls) expect(args.slice(0, 2)).toEqual(['-L', SHELL_SOCKET])
  })
})

describe('capture', () => {
  test('shapes the pane into lines plus its geometry', async () => {
    const t = fakeTmux({
      'capture-pane': { code: 0, out: 'one\ntwo\n', err: '' },
      'display-message': { code: 0, out: PANE, err: '' },
    })
    const cap = await createShellTerminal(t.run).capture('s1', 200)
    // The trailing '' from the final newline is not a row.
    expect(cap?.lines).toEqual(['one', 'two'])
    expect(cap?.info).toEqual({ cols: 80, rows: 24, cursorX: 3, cursorY: 7, alive: true, historySize: 120 })
  })

  test('a pane tmux no longer has answers null — which ENDS the stream', async () => {
    const t = fakeTmux({ 'capture-pane': { code: 1, out: '', err: "can't find session" } })
    expect(await createShellTerminal(t.run).capture('gone', 200)).toBeNull()
  })

  test('an unreadable geometry yields an honest fallback, never a confident cursor', async () => {
    const t = fakeTmux({
      'capture-pane': { code: 0, out: 'x\n', err: '' },
      'display-message': { code: 1, out: '', err: 'nope' },
    })
    const cap = await createShellTerminal(t.run).capture('s1', 200)
    expect(cap?.lines).toEqual(['x'])
    // `cols: 0` is a "don't know" the browser emulator ignores; `alive` is true because the capture
    // just worked. The same fallback `backend-tmux.ts` makes for a fleet pane.
    expect(cap?.info.cols).toBe(0)
    expect(cap?.info.alive).toBe(true)
  })

  test('a blank pane is EMPTY, not gone', async () => {
    const t = fakeTmux({
      'capture-pane': { code: 0, out: '', err: '' },
      'display-message': { code: 0, out: PANE, err: '' },
    })
    const cap = await createShellTerminal(t.run).capture('s1', 200)
    expect(cap).not.toBeNull()
    expect(cap?.lines).toEqual([])
  })
})

describe('the writes report what actually happened', () => {
  test('a non-zero send is a failure, never a silent success', async () => {
    const t = fakeTmux({ 'send-keys': { code: 1, out: '', err: 'no session' } })
    const term = createShellTerminal(t.run)
    expect(await term.sendText('s1', 'ls')).toBe(false)
    expect(await term.sendKey('s1', 'Enter')).toBe(false)
  })

  test('a zero send is a success', async () => {
    const t = fakeTmux()
    expect(await createShellTerminal(t.run).sendText('s1', 'ls')).toBe(true)
  })

  test('literal text and a named key are DIFFERENT calls', async () => {
    // `send-keys -l Enter` types five letters. Confusing the two fails silently in tmux, which is
    // why the argv builders are separate downstream.
    const t = fakeTmux()
    const term = createShellTerminal(t.run)
    await term.sendText('s1', 'Enter')
    await term.sendKey('s1', 'Enter')
    expect(t.calls[0]).toContain('-l')
    expect(t.calls[1]).not.toContain('-l')
  })

  test('a paste is a THIRD, distinct shape — set-buffer then bracketed paste-buffer', async () => {
    const t = fakeTmux()
    await createShellTerminal(t.run).sendPaste('s1', 'multi\nline\npaste')
    expect(t.calls[0]).toEqual(['-L', SHELL_SOCKET, 'set-buffer', '-b', 'agentop-paste-s1', 'multi\nline\npaste'])
    expect(t.calls[1]).toEqual(['-L', SHELL_SOCKET, 'paste-buffer', '-p', '-d', '-b', 'agentop-paste-s1', '-t', 'agentop-s1'])
  })

  test('a failed set-buffer never pastes — the read is not attempted', async () => {
    const t = fakeTmux({ 'set-buffer': { code: 1, out: '', err: 'nope' } })
    expect(await createShellTerminal(t.run).sendPaste('s1', 'x')).toBe(false)
    expect(t.calls.length).toBe(1)
  })

  test('a failed paste-buffer is reported false too', async () => {
    const t = fakeTmux({ 'paste-buffer': { code: 1, out: '', err: 'no such session' } })
    expect(await createShellTerminal(t.run).sendPaste('s1', 'x')).toBe(false)
  })
})

describe('clearing the scrollback is a NAMED keystroke, never a guess about pasted text', () => {
  const cleared = (calls: string[][]) => calls.some(a => a.includes('clear-history'))

  test('the C-l key clears it', async () => {
    const t = fakeTmux()
    await createShellTerminal(t.run).sendKey('s1', 'C-l')
    expect(cleared(t.calls)).toBe(true)
  })

  test('a lone form feed — what a physical ctrl+l puts on the wire — clears it too', async () => {
    // xterm emits ctrl+l as `\x0c` through `onData`, so it arrives as TEXT and not as a named key.
    const t = fakeTmux()
    await createShellTerminal(t.run).sendText('s1', '\x0c')
    expect(cleared(t.calls)).toBe(true)
  })

  test('the WORD `clear` does not, however it is pasted', async () => {
    // Typing goes one character at a time, so this can only ever be a PASTE — and a paste is
    // matched BEFORE the shell has run anything, so acting on it throws away the history the user
    // still has while changing nothing about what is on screen.
    for (const text of ['clear', ' clear ', 'echo hi; clear\n', 'clear\r']) {
      const t = fakeTmux()
      await createShellTerminal(t.run).sendText('s1', text)
      expect(cleared(t.calls), JSON.stringify(text)).toBe(false)
    }
  })

  test('a paste that merely CONTAINS a form feed is left alone', async () => {
    const t = fakeTmux()
    await createShellTerminal(t.run).sendText('s1', 'printf "a\x0cb"')
    expect(cleared(t.calls)).toBe(false)
  })

  test('a send that failed clears nothing', async () => {
    const t = fakeTmux({ 'send-keys': { code: 1, out: '', err: 'no such session' } })
    await createShellTerminal(t.run).sendKey('s1', 'C-l')
    expect(cleared(t.calls)).toBe(false)
  })
})
