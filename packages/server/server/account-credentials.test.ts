import { describe, expect, test } from 'bun:test'
import { classifyCredentialFile, claudeCredentialState, credentialBroken } from './account-credentials'

const oauth = (o: object) => JSON.stringify({ claudeAiOauth: o })

describe('classifyCredentialFile', () => {
  test('no file, an empty file and junk are broken; a credential is ok', () => {
    expect(classifyCredentialFile(null)).toBe('missing')
    expect(classifyCredentialFile('  \n')).toBe('empty')
    expect(classifyCredentialFile('{nope')).toBe('invalid')
    expect(classifyCredentialFile('[]')).toBe('invalid')
    expect(classifyCredentialFile('{}')).toBe('invalid')
    expect(classifyCredentialFile(oauth({ accessToken: '', refreshToken: ' ' }))).toBe('empty')
    expect(classifyCredentialFile(oauth({ accessToken: 'x' }))).toBe('ok')
    expect(classifyCredentialFile(oauth({ refreshToken: 'r' }))).toBe('ok')
  })
  test('only missing / empty / invalid are broken', () => {
    expect(['ok', 'unknown'].some(s => credentialBroken(s as never))).toBe(false)
    expect(['missing', 'empty', 'invalid'].every(s => credentialBroken(s as never))).toBe(true)
  })
})

describe('claudeCredentialState', () => {
  test('reads <root>/.credentials.json off macOS', () => {
    const seen: string[] = []
    const read = (p: string) => { seen.push(p); return null }
    expect(claudeCredentialState('/r/acc', { platform: 'linux', env: {}, read })).toBe('missing')
    expect(seen).toEqual(['/r/acc/.credentials.json'])
  })
  test('macOS keychain and an env token prove nothing', () => {
    expect(claudeCredentialState('/r', { platform: 'darwin', env: {}, read: () => null })).toBe('unknown')
    expect(claudeCredentialState('/r', { platform: 'linux', env: { CLAUDE_CODE_OAUTH_TOKEN: 't' }, read: () => null })).toBe('unknown')
  })
  test('an unreadable file is unknown, not signed out', () => {
    expect(claudeCredentialState('/r', { platform: 'linux', env: {}, read: () => { throw new Error('EACCES') } })).toBe('unknown')
  })
})
