import { describe, expect, test } from 'bun:test'
import { envNameFor, findVaultRefs, makeScrubber, makeStreamScrubber, scrubForms } from './scrub'

const S = { name: 'GITHUB_TOKEN', value: 'ghp_Abc123+/xyz==Δ' }

describe('scrub — the value and its common encodings', () => {
  const sc = makeScrubber([S])
  const enc = (s: string) => Buffer.from(s, 'utf8')
  test.each([
    ['exact', `token=${S.value}\n`],
    ['base64', `auth ${enc(S.value).toString('base64')}`],
    ['base64 no padding', enc(S.value).toString('base64').replace(/=+$/, '')],
    ['base64url', enc(S.value).toString('base64url')],
    ['url-encoded', `https://x/?k=${encodeURIComponent(S.value)}`],
    ['hex', enc(S.value).toString('hex')],
    ['HEX', enc(S.value).toString('hex').toUpperCase()],
    ['curl -v Authorization header', `> Authorization: Bearer ${S.value}\r\n`],
  ])('%s', (_k, text) => {
    const r = sc.scrub(text)
    expect(r.text).not.toContain(S.value)
    expect(r.text).toContain('«vault:GITHUB_TOKEN»')
    expect(r.hits).toEqual(['GITHUB_TOKEN'])
  })
  test('a short "secret" is not scrubbed (it would blank ordinary words)', () => {
    expect(scrubForms('abc')).toEqual([])
    expect(makeScrubber([{ name: 'X', value: 'abc' }]).scrub('abc abc').text).toBe('abc abc')
  })
  test('a multi-line value is also caught line by line', () => {
    const pem = '-----BEGIN KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8\n-----END KEY-----'
    const r = makeScrubber([{ name: 'PEM', value: pem }]).scrub('reflowed:\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8\n')
    expect(r.text).not.toContain('MIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8')
  })
  test('STATED LIMIT: a value split in pieces passes (this is not containment)', () => {
    const half = S.value.length >> 1
    const r = sc.scrub(`${S.value.slice(0, half)} ${S.value.slice(half)}`)
    expect(r.hits).toEqual([])
  })
})

describe('stream scrubbing — a value split across chunks is still caught', () => {
  test('two chunks', () => {
    const st = makeStreamScrubber([S])
    const out = st.push(`x ${S.value.slice(0, 5)}`) + st.push(`${S.value.slice(5)} y`) + st.flush()
    expect(out).not.toContain(S.value)
    expect(out).toContain('«vault:GITHUB_TOKEN»')
    expect(out.startsWith('x ')).toBe(true)
    expect(out.endsWith(' y')).toBe(true)
  })
  test('no secrets → pass-through', () => {
    const st = makeStreamScrubber([])
    expect(st.push('abc')).toBe('abc')
  })
})

describe('references', () => {
  test('vault://NAME and vault://NAME/field, deduplicated, in order', () => {
    expect(findVaultRefs('use vault://banco/login and vault://banco/password, vault://OPENAI_API_KEY vault://banco/login'))
      .toEqual([{ name: 'banco', field: 'login', raw: 'vault://banco/login' }, { name: 'banco', field: 'password', raw: 'vault://banco/password' }, { name: 'OPENAI_API_KEY', field: null, raw: 'vault://OPENAI_API_KEY' }])
  })
  test('env names', () => {
    expect(envNameFor('banco-itau', 'password')).toBe('VAULT_BANCO_ITAU_PASSWORD')
    expect(envNameFor('OPENAI_API_KEY', null)).toBe('VAULT_OPENAI_API_KEY')
  })
})
