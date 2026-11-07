import { afterEach, describe, expect, test } from 'bun:test'
import {
  clampAutoLock, forgetGrant, gateFor, grantAlive, minutesLeft, missingSteps, parseAutoLockInput,
  rememberGrant, remainingMs, wordRows, wizardPlan, gestureStep, howStep2, askWords, sectionBadge, howNow, howConfirms, primarySection,
  confirmsWithPasswordOnly, wantsVaultPassword, setVaultPasswordPrompt,
} from './vaultApi'
import { VAULT_TEXT, presenceKey, vt, vtf } from './vaultText'

const gates = {
  list: { code: true, gesture: false, grant: true },
  lock: { code: true, gesture: false, grant: true },
  'disable-presence': { code: true, gesture: true, grant: false },
  'lock-local': { code: false, gesture: false, grant: false },
}

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

describe('gates — COFRE.DESBLOQUEIO: no code is ever typed; a proof row asks the confirmation', () => {
  test('never a code; a row that used to ask the code now asks the confirmation, once there is one', () => {
    expect(gateFor({ gates, presence: false }, 'lock')).toEqual({ code: false, gesture: false, grant: true })
    expect(gateFor({ gates, presence: true }, 'lock')).toEqual({ code: false, gesture: true, grant: true })
    expect(gateFor({ gates, presence: true }, 'disable-presence')).toEqual({ code: false, gesture: true, grant: false })
    expect(gateFor({ gates, presence: true }, 'unknown-action')).toEqual({ code: false, gesture: false, grant: false })
    expect(gateFor({ gates, presence: true }, 'lock-local')).toMatchObject({ code: false, gesture: false })
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
  const none = { recoveryCreatedAt: null, presence: false, presenceAvailable: ['password'] }
  test('fresh: the way to confirm, then the recovery key LAST (leader decision 2) — never an authenticator', () => {
    expect(missingSteps(none)).toEqual(['presence', 'recovery'])
  })
  test('nothing offered (an old server): the step is not offered (never offered and failing)', () => {
    expect(missingSteps({ ...none, presenceAvailable: [] })).toEqual(['recovery'])
  })
  test('done: nothing', () => {
    expect(missingSteps({ recoveryCreatedAt: 'x', presence: true, presenceAvailable: ['hello'] })).toEqual([])
  })
})

describe('the 24 words', () => {
  test('6 rows of 4, numbered 1..24 in reading order', () => {
    const rows = wordRows(Array.from({ length: 24 }, (_, i) => `w${i + 1}`))
    expect(rows).toHaveLength(6)
    expect(rows.every(r => r.length === 4)).toBe(true)
    expect(rows.flat().map(w => w.n)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1))
    expect(rows[5]![3]).toEqual({ n: 24, word: 'w24' })
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
  test('the confirmation word follows the wrapper the vault holds — a gesture first', () => {
    expect(vt(presenceKey(['hello', 'recovery']), 'en')).toBe('Windows Hello')
    expect(vt(presenceKey(['fido2']), 'pt')).toBe('sua chave de segurança')
    expect(vt(presenceKey(['touchid', 'password']), 'pt')).toBe('o Touch ID (ou a senha do Mac)')
    expect(vt(presenceKey(['password']), 'en')).toBe('the vault password')
    expect(vt(presenceKey(['dpapi']), 'en')).toBe('your personal confirmation')
  })
  test('the recovery screen says the two things it must: keep it offline, and no copy', () => {
    expect(vt('wiz_rec_warn', 'en')).toContain('Keep it offline')
    expect(vt('wiz_rec_warn', 'en')).toContain('this computer can open your vault')
    expect(vt('wiz_rec_warn', 'pt')).toContain('Guarde offline')
    expect(vt('wiz_rec_once', 'en')).toContain('no copy button')
  })
})

describe('the one-go flow and the tooltips', () => {
  test('a resume runs the steps as they are; nothing to do is nothing', () => {
    expect(wizardPlan(['presence', 'recovery'])).toEqual(['presence', 'recovery'])
    expect(wizardPlan([])).toEqual([])
  })
  test('a first page enrolment asks the setup code FIRST — before any confirmation is raised', () => {
    expect(wizardPlan(['presence', 'recovery'], true)).toEqual(['setup', 'presence', 'recovery'])
    expect(wizardPlan(['recovery'], true)).toEqual(['setup', 'recovery'])
    expect(wizardPlan([], true)).toEqual([])
  })
  test('the setup step is a calm step with its own words, in both languages', () => {
    for (const lang of ['en', 'pt'] as const) {
      for (const k of ['wiz_setup_title', 'wiz_setup_intro', 'wiz_setup_run', 'wiz_setup_valid', 'wiz_setup_go', 'wiz_step_setup'] as const) {
        expect(vt(k, lang).length).toBeGreaterThan(0)
      }
    }
  })
  const words = { code: 'your code', presence: 'Windows Hello', and: ' and ', asks: 'Will ask for: {what}', nothing: 'Nothing more is asked.' }
  test('a tooltip names exactly what the gate row asks', () => {
    expect(askWords({ code: false, gesture: true }, words)).toBe('Will ask for: Windows Hello')
    expect(askWords({ code: false, gesture: false }, words)).toBe('Nothing more is asked.')
  })
  test('the owner’s wording is in place, in both languages', () => {
    expect(vt('rec_create', 'pt')).toBe('Criar chave de recuperação')
    expect(vt('rec_new', 'pt')).toBe('Gerar uma nova (a antiga para de valer)')
    expect(vt('sec_hardening', 'pt')).toBe('Proteção da memória')
    expect(vt('rec_lost', 'pt')).toContain('Recuperar com as 24 palavras')
    expect(vt('rec_create', 'en')).not.toBe(vt('rec_create', 'pt'))
  })
})

// ── review M1 / S2: what the page SENDS ─────────────────────────────────────────────────────────

import { cleanSetupCode, presenceEnrol, presenceProbe, setupCodeComplete, unlockGesture } from './vaultApi'

describe('review M1/S2 — the dashboard\'s vault requests', () => {
  const seen: { url: string; init: RequestInit }[] = []
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch; setVaultPasswordPrompt(null) })
  const capture = (answers: object[] = [{ ok: true }]) => {
    seen.length = 0
    let i = 0
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      const a = answers[Math.min(i++, answers.length - 1)]
      return new Response(JSON.stringify(a), { status: (a as { ok?: boolean }).ok ? 200 : 401 })
    }) as unknown as typeof fetch
  }
  test('every POST is JSON, even one with nothing to say (the server refuses any other type)', async () => {
    capture()
    await unlockGesture()
    const h = seen[0]!.init.headers as Record<string, string>
    expect(h['Content-Type']).toBe('application/json')
    expect(seen[0]!.init.body).toBe('{}')
  })
  test('the setup code travels in the probe body when one is given', async () => {
    capture()
    await presenceProbe('password', '12345678')
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ protector: 'password', setupCode: '12345678' })
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
  test('a new vault password travels in its own header, never in the body or the URL', async () => {
    capture()
    const pw = 'Abc!def#1xyz'
    await presenceEnrol('password', { password: pw })
    const req = seen[0]!
    expect((req.init.headers as Record<string, string>)['x-vault-password']).toBe(pw)
    expect(String(req.init.body)).not.toContain(pw)
    expect(req.url).not.toContain(pw)
  })
  test('password-required: the one prompt is asked, and the request is sent again with the header', async () => {
    capture([{ ok: false, code: 'password-required', sentence: 's' }, { ok: true, state: 'open' }])
    const asked: { retry: boolean; sentence: string }[] = []
    setVaultPasswordPrompt(async a => { asked.push(a); return 'Abc!def#1xyz' })
    const r = await unlockGesture()
    expect(r.ok).toBe(true)
    expect(asked).toEqual([{ retry: false, sentence: 's' }])
    expect(seen).toHaveLength(2)
    expect((seen[0]!.init.headers as Record<string, string>)['x-vault-password']).toBeUndefined()
    expect((seen[1]!.init.headers as Record<string, string>)['x-vault-password']).toBe('Abc!def#1xyz')
  })
  test('a wrong password asks again as a retry, at most three times; cancelling stops at once', async () => {
    capture([{ ok: false, code: 'password-wrong', sentence: 'w' }])
    let n = 0
    setVaultPasswordPrompt(async a => { n++; expect(a.retry).toBe(true); return 'nope' })
    expect((await unlockGesture()).ok).toBe(false)
    expect(n).toBe(3)
    capture([{ ok: false, code: 'password-required', sentence: 's' }])
    setVaultPasswordPrompt(async () => null)
    const r = await unlockGesture()
    expect(r.ok ? 'ok' : r.code).toBe('password-required')
    expect(seen).toHaveLength(1)
  })
  test('only the two password codes raise the prompt', () => {
    expect(wantsVaultPassword({ json: { ok: false, code: 'password-required' } })).toBe(true)
    expect(wantsVaultPassword({ json: { ok: false, code: 'password-wrong' } })).toBe(true)
    expect(wantsVaultPassword({ json: { ok: false, code: 'stepup-required' } })).toBe(false)
    expect(wantsVaultPassword({ json: { ok: true, code: 'password-required' } })).toBe(false)
    expect(wantsVaultPassword(null)).toBe(false)
  })
})

describe('VAULT.UX2 — what a glance says', () => {
  const base = { presence: false, presenceAvailable: ['hello'], recoveryCreatedAt: null, hardening: null }
  test('a missing way to confirm is a "!" (it is what protects the vault); none offered is "not available"', () => {
    expect(sectionBadge(base, 'presence')).toEqual({ tone: 'warn', key: 'badge_missing' })
    expect(sectionBadge(base, 'recovery')).toEqual({ tone: 'warn', key: 'badge_missing' })
    expect(sectionBadge({ ...base, presenceAvailable: [] }, 'presence')).toEqual({ tone: 'off', key: 'badge_na' })
    expect(sectionBadge({ ...base, presence: true }, 'presence').key).toBe('badge_on')
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
    expect(howConfirms({ presence: false })).toBe('nothing')
    expect(howConfirms({ presence: true })).toBe('proof')
    expect(howStep2({ presence: true }).key).toBe('how2_proof')
    expect(howStep2({ presence: false }).key).toBe('how2_nothing')
  })
  test('exactly ONE primary action: the first missing step, and none while the banner carries it', () => {
    expect(primarySection(['presence', 'recovery'], false)).toBe('presence')
    expect(primarySection(['recovery'], false)).toBe('recovery')
    expect(primarySection(['presence'], true)).toBeNull()
    expect(primarySection([], false)).toBeNull()
  })
  test('the page asks inline only for a vault that confirms with its password alone', () => {
    expect(confirmsWithPasswordOnly({ wrappers: ['keychain', 'password'] })).toBe(true)
    expect(confirmsWithPasswordOnly({ wrappers: ['password', 'touchid'] })).toBe(false)
    expect(confirmsWithPasswordOnly({ wrappers: ['hello'] })).toBe(false)
  })
})

describe('live gesture progress (owner 2026-10-02)', () => {
  test('"confirmation i of n" names the one being asked, never past n', () => {
    expect(gestureStep({ kind: 'hello', done: 0, total: 2 })).toEqual({ i: 1, n: 2 })
    expect(gestureStep({ kind: 'hello', done: 1, total: 2 })).toEqual({ i: 2, n: 2 })
    expect(gestureStep({ kind: 'hello', done: 2, total: 2 })).toEqual({ i: 2, n: 2 })
    expect(gestureStep(null)).toBeNull()
    expect(gestureStep({ kind: 'hello', done: 0, total: 0 })).toBeNull()
  })
  test('the counts are said with the number, in both languages', () => {
    expect(vt('wiz_pres_checkHello', 'pt')).toContain('não pede nada')
    expect(vtf('wiz_pres_enrolHello', 'pt', { n: 2 })).toContain('2 vezes')
    expect(vtf('wiz_gesture_progress', 'pt', { i: 1, n: 2 })).toBe('Confirmação 1 de 2')
    expect(vtf('wiz_gesture_progress', 'en', { i: 2, n: 3 })).toBe('Confirmation 2 of 3')
  })
})

// ── v2.98.1 ─────────────────────────────────────────────────────────────────────────────────
import { addableKinds, recoverySteps, splitWords } from './vaultApi'

describe('v2.98.1: what the page offers', () => {
  test('a loopback page with a gesture method starts with ONE gesture instead of the setup code', () => {
    expect(wizardPlan(['presence', 'recovery'], true, true)).toEqual(['local', 'presence', 'recovery'])
    expect(wizardPlan(['presence', 'recovery'], true, false)[0]).toBe('setup')
    expect(wizardPlan(['presence'], false, true)).toEqual(['presence'])
  })
  test('presence ON: only kinds that are offered AND not enrolled can be added — never the same one again', () => {
    expect(addableKinds({ presenceAvailable: ['hello'], wrappers: ['hello', 'recovery'] })).toEqual([])
    expect(addableKinds({ presenceAvailable: ['hello', 'password', 'fido2'], wrappers: ['hello'] })).toEqual(['password', 'fido2'])
    expect(addableKinds({ presenceAvailable: ['touchid', 'password'], wrappers: ['password'] })).toEqual(['touchid'])
  })
  test('the 24 words from a paste, numbered or not', () => {
    expect(splitWords('1. Abandon 2. ability\n3) able')).toEqual(['abandon', 'ability', 'able'])
    expect(splitWords('a, b; c   d')).toEqual(['a', 'b', 'c', 'd'])
    expect(splitWords('x '.repeat(30)).length).toBe(24)
  })
  test('after a page recovery the wizard runs what the server still owes, in order — an old "authenticator" is dropped', () => {
    expect(recoverySteps(['recovery', 'authenticator', 'presence'])).toEqual(['presence', 'recovery'])
    expect(recoverySteps(null)).toEqual([])
  })
})
