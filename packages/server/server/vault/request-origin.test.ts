import { describe, expect, test } from 'bun:test'
import { actualOriginSecure, informationalSecure } from './request-origin'

const url = new URL('http://alien-wsl.seahorse-cobia.ts.net:47292/api/vault/phone')

describe('vault request origin', () => {
  test('same-origin GET without Origin is secure behind forwarded HTTPS', () => {
    const req = new Request(url, { headers: { host: url.host, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'alien-wsl.seahorse-cobia.ts.net:8443' } })
    expect(informationalSecure(req, url)).toBe(true)
  })

  test('same-origin GET without Origin over plain HTTP is not secure', () => {
    const req = new Request(url, { headers: { host: url.host } })
    expect(informationalSecure(req, url)).toBe(false)
  })

  test('a mismatched real Origin is not secure and cannot be rescued by forwarding headers', () => {
    const req = new Request(url, { headers: { origin: 'https://other.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': url.host } })
    expect(informationalSecure(req, url)).toBe(false)
    expect(actualOriginSecure(req, url)).toBe(false)
  })
})
