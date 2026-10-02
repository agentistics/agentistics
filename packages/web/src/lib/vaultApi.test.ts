import { describe, expect, test } from 'bun:test'
import {
  clampAutoLock, cleanCode, codeComplete, forgetGrant, gateFor, grantAlive, minutesLeft, missingSteps, needsTypedCode, parseAutoLockInput,
  rememberGrant, remainingMs, wordRows, wizardPlan, askWords, sectionBadge, howNow, howConfirms, primarySection,
} from './vaultApi'
import { VAULT_TEXT, presenceKey, vt, vtf } from './vaultText'

const gates = {
  list: { code: true, gesture: false, grant: true },
  lock: { code: true, gesture: false, grant: true },
  'disable-presence': { code: true, gesture: true, grant: false },
  'lock-local': { code: false, gesture: false, grant: false },
}
const auth = { enrolledAt: 'x', lastUsedAt: null, failures: 0, pausedUntil: null, frozen: false }

describe('auto-lock input (§5.1: 5–480 whole minutes, no "never")', () => {
  test('parses digits only', () => {
    expect(parseAutoLockInput('30')).toBe(30)
    expect(parseAutoLockInput(' 480 ')).toBe(480)
    for (const bad of ['', 'never', '1.5', '-5', '12345', 'abc']) expect(parseAutoLockInput(bad)).toBeNull()
  })
  test('clamps to the bounds', () => {
    expect(clampAutoLock(1)).toBe(5)
    expect(clampAutoLock(5)).toBe(5)
    expect(clampAutoLock(481)).toBe(480)
    expect(clampAutoLock(999)).toBe(480)
    expect(clampAutoLock(NaN)).toBe(30)
    expect(clampAutoLock(29.6)).toBe(30)
  })
})

describe('the countdown', () => {
  test('counts down from when the server reported it, never below 0, and null stays null', () => {
    expect(remainingMs(60_000, 1000, 11_000)).toBe(50_000)
    expect(remainingMs(60_000, 1000, 99_000)).toBe(0)
    expect(remainingMs(null, 0, 5)).toBeNull()
  })
  test('minutes round UP so an open vault never reads "0 min"', () => {
    expect(minutesLeft(1)).toBe(1)
    expect(minutesLeft(60_000)).toBe(1)
    expect(minutesLeft(60_001)).toBe(2)
    expect(minutesLeft(23 * 60_000 - 5)).toBe(23)
    expect(minutesLeft(0)).toBe(0)
  })
})

describe('gates — read from the SERVER table, then narrowed by what this vault has', () => {
  test('the code is asked only once an authenticator is enrolled; the gesture only with presence', () => {
    expect(gateFor({ gates, authenticator: null, presence: false }, 'lock')).toMatchObject({ code: false, gesture: false })
    expect(gateFor({ gates, authenticator: auth, presence: false }, 'disable-presence')).toMatchObject({ code: true, gesture: false })
    expect(gateFor({ gates, authenticator: auth, presence: true }, 'disable-presence')).toMatchObject({ code: true, gesture: true, grant: false })
    expect(gateFor({ gates, authenticator: auth, presence: true }, 'unknown-action')).toEqual({ code: false, gesture: false, grant: false })
    expect(gateFor({ gates, authenticator: auth, presence: true }, 'lock-local')).toMatchObject({ code: false, gesture: false })
  })
  test('a live grant stands in for a typed code only where the row allows it', () => {
    expect(needsTypedCode({ code: true, grant: true }, true)).toBe(false)
    expect(needsTypedCode({ code: true, grant: true }, false)).toBe(true)
    expect(needsTypedCode({ code: true, grant: false }, true)).toBe(true) // destructive: fresh every time
    expect(needsTypedCode({ code: false, grant: true }, false)).toBe(false)
  })
  test('the grant lives in memory for 5 minutes minus a margin, and forgetting it is immediate', () => {
    forgetGrant()
    expect(grantAlive(1)).toBe(false)
    rememberGrant('tok', 1_000)
    expect(grantAlive(1_000 + 60_000)).toBe(true)
    expect(grantAlive(1_000 + 5 * 60_000)).toBe(false)
    forgetGrant()
    expect(grantAlive(1_001)).toBe(false)
  })
})

describe('what the wizard still has to do', () => {
  const none = { authenticator: null, recoveryCreatedAt: null, presence: false, presenceAvailable: ['hello'] }
  test('fresh: authenticator, recovery, presence — presence LAST', () => {
    expect(missingSteps(none)).toEqual(['authenticator', 'recovery', 'presence'])
  })
  test('no presence device: the step is not offered (never offered and failing)', () => {
    expect(missingSteps({ ...none, presenceAvailable: [] })).toEqual(['authenticator', 'recovery'])
  })
  test('done: nothing', () => {
    expect(missingSteps({ authenticator: auth, recoveryCreatedAt: 'x', presence: true, presenceAvailable: ['hello'] })).toEqual([])
  })
})

describe('the 24 words and the code field', () => {
  test('6 rows of 4, numbered 1..24 in reading order', () => {
    const rows = wordRows(Array.from({ length: 24 }, (_, i) => `w${i + 1}`))
    expect(rows).toHaveLength(6)
    expect(rows.every(r => r.length === 4)).toBe(true)
    expect(rows.flat().map(w => w.n)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1))
    expect(rows[5]![3]).toEqual({ n: 24, word: 'w24' })
  })
  test('a code is digits only, at most 6; complete means exactly 6', () => {
    expect(cleanCode('12 34-56789')).toBe('123456')
    expect(codeComplete('123456')).toBe(true)
    expect(codeComplete('12345')).toBe(false)
    expect(codeComplete('12345a')).toBe(false)
  })
})

describe('words', () => {
  test('placeholders are filled and a missing one is empty, never "undefined"', () => {
    expect(vtf('openLocksIn', 'en', { n: 23 })).toBe('Open · locks in 23 min')
    expect(vtf('openLocksIn', 'pt', { n: 23 })).toBe('Aberto · trava em 23 min')
    expect(vtf('wiz_step', 'en', { i: 2 })).toBe('Step 2 of ')
  })
  test('every placeholder in one language exists in the other (a translation cannot drop a value)', () => {
    for (const [k, v] of Object.entries(VAULT_TEXT)) {
      const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join()
      expect(ph(v.en), k).toBe(ph(v.pt))
    }
  })
  test('the presence word follows the wrapper the vault holds', () => {
    expect(vt(presenceKey(['hello', 'recovery']), 'en')).toBe('Windows Hello')
    expect(vt(presenceKey(['fido2']), 'pt')).toBe('sua chave de segurança')
    expect(vt(presenceKey(['dpapi']), 'en')).toBe('your presence device')
  })
  test('the recovery screen says the two things it must: keep it offline, and no copy', () => {
    expect(vt('wiz_rec_warn', 'en')).toContain('Keep it offline')
    expect(vt('wiz_rec_warn', 'en')).toContain('this computer can open your vault')
    expect(vt('wiz_rec_warn', 'pt')).toContain('Guarde offline')
    expect(vt('wiz_rec_once', 'en')).toContain('no copy button')
  })
})

describe('the one-go flow and the tooltips (owner feedback 2026-10-02)', () => {
  test('a fresh machine runs the device check FIRST, then authenticator → recovery → presence', () => {
    expect(wizardPlan(['authenticator', 'recovery', 'presence'])).toEqual(['probe', 'authenticator', 'recovery', 'presence'])
  })
  test('a resume has no probe (the presence enrolment is its own double gesture); no presence device, no probe', () => {
    expect(wizardPlan(['recovery', 'presence'])).toEqual(['recovery', 'presence'])
    expect(wizardPlan(['authenticator', 'recovery'])).toEqual(['authenticator', 'recovery'])
    expect(wizardPlan([])).toEqual([])
  })
  const words = { code: 'your code', presence: 'Windows Hello', and: ' and ', asks: 'Will ask for: {what}', nothing: 'Nothing more is asked.' }
  test('a tooltip names exactly what the gate row asks', () => {
    expect(askWords({ code: true, gesture: true }, words)).toBe('Will ask for: your code and Windows Hello')
    expect(askWords({ code: true, gesture: false }, words)).toBe('Will ask for: your code')
    expect(askWords({ code: false, gesture: true }, words)).toBe('Will ask for: Windows Hello')
    expect(askWords({ code: false, gesture: false }, words)).toBe('Nothing more is asked.')
  })
  test('the owner’s wording is in place, in both languages', () => {
    expect(vt('pres_off', 'pt')).toBe('Desligada. Hoje o cofre abre sozinho quando o agentistics liga, sem pedir sua digital/PIN.')
    expect(vt('pres_turnOn', 'pt')).toBe('Exigir Windows Hello')
    expect(vt('rec_create', 'pt')).toBe('Criar chave de recuperação')
    expect(vt('rec_new', 'pt')).toBe('Gerar uma nova (a antiga para de valer)')
    expect(vt('sec_hardening', 'pt')).toBe('Proteção da memória')
    expect(vt('auth_explain', 'pt')).toBe('O código do app é pedido para abrir o cofre e para mudar estas configurações.')
    expect(vt('rec_lost', 'pt')).toContain('agentop vault recover')
    expect(vt('rec_create', 'en')).not.toBe(vt('rec_create', 'pt'))
  })
})

// ── review M1 / S2: what the page SENDS ─────────────────────────────────────────────────────────

import { authenticatorBegin, cleanSetupCode, setupCodeComplete, unlockGesture } from './vaultApi'

describe('review M1/S2 — the dashboard\'s vault requests', () => {
  const seen: { url: string; init: RequestInit }[] = []
  const realFetch = globalThis.fetch
  const capture = () => {
    seen.length = 0
    globalThis.fetch = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response('{"ok":true}') }) as unknown as typeof fetch
  }
  test('every POST is JSON, even one with nothing to say (the server refuses any other type)', async () => {
    capture()
    try { await unlockGesture() } finally { globalThis.fetch = realFetch }
    const h = seen[0]!.init.headers as Record<string, string>
    expect(h['Content-Type']).toBe('application/json')
    expect(seen[0]!.init.body).toBe('{}')
  })
  test('the setup code travels in the begin body when one is given', async () => {
    capture()
    try { await authenticatorBegin(undefined, '12345678') } finally { globalThis.fetch = realFetch }
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ setupCode: '12345678' })
  })
  test('the setup code field keeps 8 digits and ignores spaces and dashes', () => {
    expect(cleanSetupCode('1234 5678')).toBe('12345678')
    expect(cleanSetupCode('1234-56789')).toBe('12345678')
    expect(setupCodeComplete('12345678')).toBe(true)
    expect(setupCodeComplete('1234567')).toBe(false)
  })
  test('the setup-code sentence exists in EN and PT and names the terminal command', () => {
    expect(vt('wiz_setup_why', 'en')).toContain('agentop vault setup-code')
    expect(vt('wiz_setup_why', 'pt')).toContain('agentop vault setup-code')
  })
})

describe('VAULT.UX2 — what a glance says', () => {
  const base = { authenticator: null, presence: false, presenceAvailable: ['hello'], recoveryCreatedAt: null, hardening: null }
  test('missing setup is a "!" (warn); presence the machine can have is only "recommended"; one it cannot have is "not available"', () => {
    expect(sectionBadge(base, 'authenticator')).toEqual({ tone: 'warn', key: 'badge_missing' })
    expect(sectionBadge(base, 'recovery')).toEqual({ tone: 'warn', key: 'badge_missing' })
    expect(sectionBadge(base, 'presence')).toEqual({ tone: 'rec', key: 'badge_recommended' })
    expect(sectionBadge({ ...base, presenceAvailable: [] }, 'presence')).toEqual({ tone: 'off', key: 'badge_na' })
  })
  test('configured is ✓; a frozen or paused authenticator is attention, not configured', () => {
    const a = { enrolledAt: 'x', lastUsedAt: null, failures: 0, pausedUntil: null, frozen: false }
    expect(sectionBadge({ ...base, authenticator: a, presence: true, recoveryCreatedAt: 'y' }, 'authenticator').tone).toBe('ok')
    expect(sectionBadge({ ...base, authenticator: a, presence: true, recoveryCreatedAt: 'y' }, 'presence').key).toBe('badge_on')
    expect(sectionBadge({ ...base, authenticator: { ...a, frozen: true } }, 'authenticator')).toEqual({ tone: 'warn', key: 'badge_attention' })
    expect(sectionBadge({ ...base, authenticator: { ...a, pausedUntil: 'z' } }, 'authenticator').key).toBe('badge_attention')
  })
  test('memory protection: only claimed when verified; a failure or a leak is attention; Windows (limited) is stated, not praised', () => {
    const h = (o: object) => ({ state: 'ok', private: true, coreDumps: 'off', yama: null, lines: [], ...o }) as never
    expect(sectionBadge({ ...base, hardening: h({}) }, 'memory')).toEqual({ tone: 'ok', key: 'badge_active' })
    expect(sectionBadge({ ...base, hardening: h({ private: false }) }, 'memory').tone).toBe('warn')
    expect(sectionBadge({ ...base, hardening: h({ coreDumps: 'on' }) }, 'memory').tone).toBe('warn')
    expect(sectionBadge({ ...base, hardening: h({ state: 'failed' }) }, 'memory').tone).toBe('warn')
    expect(sectionBadge({ ...base, hardening: h({ state: 'limited', private: null, coreDumps: null }) }, 'memory').tone).toBe('off')
    expect(sectionBadge(base, 'memory').tone).toBe('off')
  })
  test('secrets: pending plaintext is a warning, otherwise ✓', () => {
    expect(sectionBadge(base, 'secrets', { sealed: 3, pending: 0 })).toEqual({ tone: 'ok', key: 'badge_sealed' })
    expect(sectionBadge(base, 'secrets', { sealed: 3, pending: 1 })).toEqual({ tone: 'warn', key: 'badge_pending' })
  })
  test('where the person is on locked → confirm → open, and what step 2 asks', () => {
    expect(howNow({ state: 'locked', pendingStepup: false })).toBe(0)
    expect(howNow({ state: 'locked', pendingStepup: true })).toBe(1)
    expect(howNow({ state: 'open', pendingStepup: false })).toBe(2)
    const a = { enrolledAt: 'x', lastUsedAt: null, failures: 0, pausedUntil: null, frozen: false }
    expect(howConfirms({ authenticator: null, presence: false })).toBe('nothing')
    expect(howConfirms({ authenticator: a, presence: false })).toBe('code')
    expect(howConfirms({ authenticator: a, presence: true })).toBe('both')
  })
  test('exactly ONE primary action: the first missing step, and none while the banner carries it', () => {
    expect(primarySection(['authenticator', 'recovery', 'presence'], false)).toBe('authenticator')
    expect(primarySection(['recovery', 'presence'], false)).toBe('recovery')
    expect(primarySection(['authenticator'], true)).toBeNull()
    expect(primarySection([], false)).toBeNull()
  })
})
