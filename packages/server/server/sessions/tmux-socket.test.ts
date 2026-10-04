import { describe, expect, test } from 'bun:test'
import { SHELL_SOCKET, TMUX_SOCKET, socketForDataDir } from './tmux-socket'

describe('the tmux socket follows the data dir (a preview never sees the owner\'s sessions)', () => {
  test('the owner\'s own store keeps the historical names', () => {
    expect(socketForDataDir('agentop', '/home/o/.agentistics', '/home/o/.agentistics')).toBe('agentop')
    expect(socketForDataDir('agentop-shell', '/home/o/.agentistics/', '/home/o/.agentistics')).toBe('agentop-shell')
  })
  test('any other data dir — an isolated HOME, a second instance — gets its own, stable socket', () => {
    const preview = socketForDataDir('agentop', '/tmp/pv/home/.agentistics', '/home/o/.agentistics')
    expect(preview).toMatch(/^agentop-[0-9a-f]{8}$/)
    expect(socketForDataDir('agentop', '/tmp/pv/home/.agentistics', '/home/o/.agentistics')).toBe(preview)
    expect(socketForDataDir('agentop', '/tmp/other/.agentistics', '/home/o/.agentistics')).not.toBe(preview)
    expect(socketForDataDir('agentop-shell', '/tmp/pv/home/.agentistics', '/home/o/.agentistics')).toMatch(/^agentop-shell-[0-9a-f]{8}$/)
  })
  test('a test run (its own temporary data dir) is never on the owner\'s sockets', () => {
    expect(TMUX_SOCKET).not.toBe('agentop')
    expect(SHELL_SOCKET).not.toBe('agentop-shell')
    expect(TMUX_SOCKET).not.toBe(SHELL_SOCKET)
  })
})
