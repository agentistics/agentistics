import { describe, expect, test } from 'bun:test'
import { mobilePushFailureMessage } from './mobilePush'

describe('mobile push failures', () => {
  test('translates a locked-vault response in Portuguese and English', () => {
    expect(mobilePushFailureMessage(503, 'mobile push is unavailable until the vault is unlocked', true))
      .toContain('cofre está bloqueado')
    expect(mobilePushFailureMessage(503, 'mobile push is unavailable until the vault is unlocked', false))
      .toContain('vault is locked')
  })

  test('explains a generic server failure without exposing the response text', () => {
    const message = mobilePushFailureMessage(503, 'internal detail: secret token', true)
    expect(message).toContain('servidor')
    expect(message).not.toContain('secret token')
  })
})
