import { test, expect } from 'bun:test'
import { existsSync } from 'fs'
import { addHookBlock, removeHookBlock, serviceCommandFor } from './autostart'

// The update-check hook was only installed into ~/.bashrc, so zsh users (who source ~/.zshrc)
// never saw the "update available" banner. The install/uninstall now span both rc files; these
// cover the pure block transforms that back that behavior.

test('addHookBlock appends a guarded, zsh-compatible block', () => {
  const out = addHookBlock('export PATH=$PATH\n')!
  expect(out).toContain('# >>> agentop update check >>>')
  expect(out).toContain('command -v agentop >/dev/null 2>&1 && agentop check-update 2>/dev/null')
  expect(out).toContain('# <<< agentop update check <<<')
  expect(out.startsWith('export PATH=$PATH\n')).toBe(true) // preserves prior content
})

test('addHookBlock is idempotent (returns null when already present)', () => {
  const once = addHookBlock('# rc\n')!
  expect(addHookBlock(once)).toBeNull()
})

test('removeHookBlock reverses addHookBlock back to the original', () => {
  const original = 'alias ll="ls -la"\n'
  const withHook = addHookBlock(original)!
  expect(removeHookBlock(withHook)).toBe(original)
})

test('removeHookBlock returns null when the block is absent', () => {
  expect(removeHookBlock('plain rc, no hook\n')).toBeNull()
})

test('removeHookBlock throws on a corrupt block (BEGIN without END)', () => {
  expect(() => removeHookBlock('# >>> agentop update check >>>\nagentop check-update\n')).toThrow()
})

test('server and watch resolve to the running binary and never go looking for a checkout', () => {
  expect(serviceCommandFor('server')).toBe(`${process.execPath} server`)
  expect(serviceCommandFor('watch')).toBe(`${process.execPath} watch`)
})

// --- the `machine` unit's ExecStart — the Docker runtime's own boot command ---
//
// Before this, "start at boot" for the `agentistics` service could only ever mean the NATIVE
// systemd unit above, even when the user actually runs it via `docker/machine.yml`. A
// boot answer that installs the wrong mechanism is worse than not offering one, so `machine` gets
// its own command, resolved by finding the file that only exists in a repo checkout, never by
// assuming a fixed path.

test('the machine command points at a docker/machine.yml that EXISTS', () => {
  const cmd = serviceCommandFor('machine')
  expect(cmd).not.toBeNull()
  expect(cmd).toContain('docker compose -f ')
  expect(cmd).toContain('up -d')
  expect(cmd).not.toContain('--build') // boot brings back the existing image, never a rebuild
  const match = /^docker compose -f (.+) up -d$/.exec(cmd!)
  expect(match).not.toBeNull()
  expect(existsSync(match![1]!)).toBe(true)
})
