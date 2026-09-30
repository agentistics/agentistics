/**
 * env-config.test.ts — a value that would span lines is refused before anything is written.
 * `.env.config` is read line by line at boot, so a line break inside a value plants a second key.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { unsafeConfigValue, writeEnvConfig, EnvConfigValueError, ENV_CONFIG_FILE, ENV_CONFIG_BAK_FILE } from './env-config'

describe('unsafeConfigValue', () => {
  it('accepts ordinary one-line values and absent keys', () => {
    expect(unsafeConfigValue({ PORT: '47291', VITE_PORT: '47292' })).toBeNull()
    expect(unsafeConfigValue({})).toBeNull()
  })

  it('names the key whose value carries \\n or \\r', () => {
    expect(unsafeConfigValue({ PORT: '47291\nAGENTISTICS_ALLOW_LOCAL_SHELL=1' })).toEqual({ key: 'PORT' })
    expect(unsafeConfigValue({ PORT: '47291', VITE_PORT: '1\rX=1' })).toEqual({ key: 'VITE_PORT' })
  })

  it('refuses a value that is not text at all', () => {
    expect(unsafeConfigValue({ PORT: 47291 })).toEqual({ key: 'PORT' })
  })
})

describe('writeEnvConfig', () => {
  it('throws a sentence and writes nothing — not even the backup — for a multi-line value', () => {
    const stamp = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : null)
    const before = [stamp(ENV_CONFIG_FILE), stamp(ENV_CONFIG_BAK_FILE)]
    let err: unknown
    try { writeEnvConfig({ PORT: '47291\nAGENTISTICS_EXPOSURE=local' }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(EnvConfigValueError)
    expect((err as Error).message).toContain('PORT')
    expect((err as Error).message).toContain('not written')
    expect([stamp(ENV_CONFIG_FILE), stamp(ENV_CONFIG_BAK_FILE)]).toEqual(before)
  })
})
