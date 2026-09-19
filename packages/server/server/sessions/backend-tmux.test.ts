import { describe, expect, test } from 'bun:test'
import { pasteWriteArgs } from './backend-tmux'
import { TMUX_SOCKET } from './tmux-cli'

/**
 * `pasteWriteArgs` is the PURE core of `tmuxBackend.sendPaste` — the fleet-session paste path
 * (`/api/fleet/input`), as opposed to `shell-terminal.ts`'s already-covered twin. Extracted so the
 * argv shape, the sanitizer, and the buffer deletion can all be proven without spawning tmux or
 * going through the pane write lock (`writeToPane`), which is `pane-writer.ts`'s own concern.
 */
describe('pasteWriteArgs — the argv shape (fleet socket, distinct from the Shell)', () => {
  test('set-buffer then a bracketed, self-deleting paste-buffer, on the FLEET socket', () => {
    const { setArgs, pasteArgs } = pasteWriteArgs('s1', 'multi\nline\npaste')
    expect(setArgs).toEqual(['-L', TMUX_SOCKET, 'set-buffer', '-b', 'agentop-paste-s1', 'multi\nline\npaste'])
    expect(pasteArgs).toEqual(['-L', TMUX_SOCKET, 'paste-buffer', '-p', '-d', '-b', 'agentop-paste-s1', '-t', 'agentop-s1'])
  })

  test('the buffer name is scoped per pane — two ids never collide', () => {
    const a = pasteWriteArgs('aaa', 'x')
    const b = pasteWriteArgs('bbb', 'x')
    expect(a.setArgs).not.toEqual(b.setArgs)
    expect(a.setArgs).toContain('agentop-paste-aaa')
    expect(b.setArgs).toContain('agentop-paste-bbb')
  })

  test('buffer DELETION: the paste-buffer call carries `-d`, so nothing accumulates across pastes', () => {
    const { pasteArgs } = pasteWriteArgs('s1', 'anything')
    expect(pasteArgs).toContain('-d')
  })

  test('bracketed: the paste-buffer call carries `-p`, requesting bracketed paste from tmux', () => {
    const { pasteArgs } = pasteWriteArgs('s1', 'anything')
    expect(pasteArgs).toContain('-p')
  })
})

describe('pasteWriteArgs — the sanitizer is applied before ANYTHING reaches the argv (C1)', () => {
  test('THE LIVE REPRO PAYLOAD: a planted bracketed-paste END marker never reaches the buffer', () => {
    // Exactly the reviewer's reproduced exploit: `\x1b[201~touch /tmp/marker\r` closed bracketed
    // paste early in the target pane and ran the command for real. `text` (the sanitized result)
    // and `setArgs` (what actually gets written into the tmux buffer) must both be clean.
    const { setArgs, text } = pasteWriteArgs('s1', '\x1b[201~touch /tmp/marker\r')
    expect(text).toBe('touch /tmp/marker\r')
    expect(setArgs).toEqual(['-L', TMUX_SOCKET, 'set-buffer', '-b', 'agentop-paste-s1', 'touch /tmp/marker\r'])
    expect(setArgs.join('')).not.toContain('\x1b')
  })

  test('nested/split markers do not survive into the buffer either', () => {
    const { text } = pasteWriteArgs('s1', '\x1b[20\x1b[201~1~')
    expect(text).toBe('')
  })

  test('a raw ESC, Ctrl-C and Ctrl-D are stripped from what reaches the buffer', () => {
    const { text } = pasteWriteArgs('s1', 'a\x1bb\x03c\x04d')
    expect(text).toBe('abcd')
  })

  test('a legitimate multi-line paste reaches the buffer BYTE-FOR-BYTE unchanged', () => {
    const clean = 'PASTE_LINE_A\nPASTE_LINE_B\nPASTE_LINE_C'
    const { text, setArgs } = pasteWriteArgs('s1', clean)
    expect(text).toBe(clean)
    expect(setArgs).toContain(clean)
  })

  test('THIS is the second boundary — applied here independent of whatever the WS channel already did', () => {
    // `input-protocol.ts` (`parseInputMessage`) already sanitizes everything reaching this backend
    // through the ordinary write channel, so this text SHOULD already be clean by the time it gets
    // here in production. This function sanitizes again regardless — belt and braces at the actual
    // primitive that writes into tmux, the same two-boundary shape `redact.ts` uses.
    const { text } = pasteWriteArgs('s1', '\x1b[200~evil\x1b[201~')
    expect(text).toBe('evil')
  })
})
