import { describe, expect, test } from 'bun:test'
import { binaryTargets, DATA_WARNING, parseUninstallArgs, planUninstall, safeDataDir } from './uninstall-plan'

describe('uninstall plan', () => {
  test('args', () => {
    expect(parseUninstallArgs([])).toEqual({ kind: 'run', yes: false, keepData: false })
    expect(parseUninstallArgs(['--yes', '--keep-data'])).toEqual({ kind: 'run', yes: true, keepData: true })
    expect(parseUninstallArgs(['-y'])).toEqual({ kind: 'run', yes: true, keepData: false })
    expect(parseUninstallArgs(['--help']).kind).toBe('help')
    expect(parseUninstallArgs(['--wipe'])).toEqual({ kind: 'unknown', arg: '--wipe' })
  })
  test('steps: data only when asked, windows only on WSL, binary only when installed', () => {
    expect(planUninstall({ wsl: false, installedBinary: true, deleteData: false })).toEqual(['services', 'update-hook', 'binary'])
    expect(planUninstall({ wsl: true, installedBinary: true, deleteData: true }))
      .toEqual(['services', 'update-hook', 'windows-entry', 'binary', 'data'])
    expect(planUninstall({ wsl: false, installedBinary: false, deleteData: false })).toEqual(['services', 'update-hook'])
  })
  test('the data warning names the vault and the 24 words', () => {
    expect(DATA_WARNING).toContain('VAULT')
    expect(DATA_WARNING).toContain('24')
  })
  test('binary targets include the .bak', () => {
    expect(binaryTargets('/home/a/.local/bin/agentop')).toEqual(['/home/a/.local/bin/agentop', '/home/a/.local/bin/agentop.bak'])
  })
  test('safeDataDir refuses roots, homes and relative paths', () => {
    expect(safeDataDir('/home/a/.agentistics', '/home/a')).toBe(true)
    expect(safeDataDir('/home/a', '/home/a')).toBe(false)
    expect(safeDataDir('/home/a/', '/home/a')).toBe(false)
    expect(safeDataDir('/', '/home/a')).toBe(false)
    expect(safeDataDir('/home', '/home/a')).toBe(false)
    expect(safeDataDir('.agentistics', '/home/a')).toBe(false)
  })
})
