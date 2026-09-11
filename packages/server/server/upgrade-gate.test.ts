import { describe, expect, test } from 'bun:test'
import { upgradeFromUiDecision, UPGRADE_REFUSALS } from './upgrade-gate'

const base = { capable: true, central: false, hasUpdate: true, latest: '2.30.0' }

describe('who may press "update now"', () => {
  test('a local machine with an update waiting may', () => {
    expect(upgradeFromUiDecision(base)).toEqual({ ok: true, version: '2.30.0' })
  })

  // It downloads a binary and EXECUTES it, then restarts the service serving this page. There is
  // nothing more powerful in this product, so it rides the gate the shell and the fleet ride.
  test('a profile without host power may not, and the answer names the capability', () => {
    expect(upgradeFromUiDecision({ ...base, capable: false }))
      .toEqual({ ok: false, reason: 'no-capability' })
  })

  // A central is reachable from the internet and its upgrade is a compose rebuild of minutes, not
  // a binary swap — a button here would be a remote rebuild trigger on a published host.
  test('a central may not, whatever its profile says', () => {
    expect(upgradeFromUiDecision({ ...base, central: true }))
      .toEqual({ ok: false, reason: 'central' })
    expect(upgradeFromUiDecision({ ...base, central: true, capable: true }))
      .toEqual({ ok: false, reason: 'central' })
  })

  // Without this the button is a free "download a release again" trigger, repeatable at will.
  test('a machine already on the latest version has nothing to run', () => {
    expect(upgradeFromUiDecision({ ...base, hasUpdate: false }))
      .toEqual({ ok: false, reason: 'up-to-date' })
  })

  test('an update with no version to name is refused rather than run blind', () => {
    expect(upgradeFromUiDecision({ ...base, latest: '' })).toEqual({ ok: false, reason: 'up-to-date' })
    expect(upgradeFromUiDecision({ ...base, latest: null })).toEqual({ ok: false, reason: 'up-to-date' })
  })

  test('the capability is checked BEFORE the central, so a published central never reports its profile', () => {
    // Both wrong at once: the answer must be the one that discloses least.
    expect(upgradeFromUiDecision({ ...base, capable: false, central: true }))
      .toEqual({ ok: false, reason: 'no-capability' })
  })

  // "não é um binário" NÃO pode reusar a frase de "perfil sem permissão": num checkout de
  // desenvolvimento o perfil permite perfeitamente, e a frase mandaria a pessoa mexer na exposição
  // por um motivo que não existe.
  test('every refusal has a sentence in both languages, and none is reused for another reason', () => {
    const seen = new Set<string>()
    for (const reason of ['no-capability', 'central', 'up-to-date', 'busy', 'not-a-binary'] as const) {
      expect(seen.has(UPGRADE_REFUSALS[reason].pt), reason).toBe(false)
      seen.add(UPGRADE_REFUSALS[reason].pt)
    }
    for (const reason of ['no-capability', 'central', 'up-to-date', 'busy', 'not-a-binary'] as const) {
      expect(UPGRADE_REFUSALS[reason].pt.length, reason).toBeGreaterThan(10)
      expect(UPGRADE_REFUSALS[reason].en.length, reason).toBeGreaterThan(10)
    }
  })
})
