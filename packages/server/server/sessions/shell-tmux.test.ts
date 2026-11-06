import { expect, test } from 'bun:test'
import { resolveShellTmux } from './shell-tmux'

test('macOS service finds Homebrew tmux even with only system directories on PATH', () => {
  for (const installed of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']) {
    expect(resolveShellTmux('darwin', name => name === installed ? installed : null)).toBe(installed)
  }
})

test('the executable on PATH wins over a second Homebrew installation', () => {
  expect(resolveShellTmux('darwin', name => name === 'tmux' ? '/custom/tmux' : name)).toBe('/custom/tmux')
})

test('Linux does not search macOS installations and missing executables are explicit', () => {
  const tried: string[] = []
  expect(resolveShellTmux('linux', name => { tried.push(name); return null })).toBeNull()
  expect(tried).toEqual(['tmux'])
  expect(resolveShellTmux('darwin', () => null)).toBeNull()
})
