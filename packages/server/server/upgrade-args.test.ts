import { describe, expect, test } from 'bun:test'
import { parseUpgradeArgs, UPGRADE_HELP } from './upgrade-args'

describe('parseUpgradeArgs', () => {
  test('no flags upgrades', () => expect(parseUpgradeArgs([])).toEqual({ kind: 'run' }))
  test('known --lang forms upgrade', () => {
    expect(parseUpgradeArgs(['--lang', 'pt'])).toEqual({ kind: 'run' })
    expect(parseUpgradeArgs(['--lang=en'])).toEqual({ kind: 'run' })
  })
  test('--help and -h print help, even beside other flags', () => {
    expect(parseUpgradeArgs(['--help']).kind).toBe('help')
    expect(parseUpgradeArgs(['-h']).kind).toBe('help')
    expect(parseUpgradeArgs(['--bogus', '-h']).kind).toBe('help')
  })
  test('an unknown flag or stray word never upgrades', () => {
    expect(parseUpgradeArgs(['--force'])).toEqual({ kind: 'unknown', arg: '--force' })
    expect(parseUpgradeArgs(['now'])).toEqual({ kind: 'unknown', arg: 'now' })
    expect(parseUpgradeArgs(['--lang', 'fr']).kind).toBe('unknown')
    expect(parseUpgradeArgs(['--lang']).kind).toBe('unknown')
  })
  test('the help names the guarantee', () => expect(UPGRADE_HELP).toContain('Any other flag is refused'))
})
