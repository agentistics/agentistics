import { describe, expect, test } from 'bun:test'
import { upgradeFromUiDecision, UPGRADE_REFUSALS } from './upgrade-gate'

const base = { capable: true, hasUpdate: true, latest: '2.30.0' }

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

  // The published image runs the compiled `agentop`, so the not-a-binary refusal no longer catches
  // it: without this a machine container would swap the binary inside itself, lost on recreate.
  test('a container may not upgrade itself — it is replaced by its image', () => {
    expect(upgradeFromUiDecision({ ...base, container: true }))
      .toEqual({ ok: false, reason: 'container' })
    expect(upgradeFromUiDecision({ ...base, container: false }))
      .toEqual({ ok: true, version: '2.30.0' })
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

  // "não é um binário" NÃO pode reusar a frase de "perfil sem permissão": num checkout de
  // desenvolvimento o perfil permite perfeitamente, e a frase mandaria a pessoa mexer na exposição
  // por um motivo que não existe.
  test('every refusal has a sentence in both languages, and none is reused for another reason', () => {
    const seen = new Set<string>()
    for (const reason of ['no-capability', 'container', 'up-to-date', 'busy', 'not-a-binary'] as const) {
      expect(seen.has(UPGRADE_REFUSALS[reason].pt), reason).toBe(false)
      seen.add(UPGRADE_REFUSALS[reason].pt)
    }
    for (const reason of ['no-capability', 'container', 'up-to-date', 'busy', 'not-a-binary'] as const) {
      expect(UPGRADE_REFUSALS[reason].pt.length, reason).toBeGreaterThan(10)
      expect(UPGRADE_REFUSALS[reason].en.length, reason).toBeGreaterThan(10)
    }
  })
})
