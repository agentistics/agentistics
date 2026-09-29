import { test, expect } from 'bun:test'
import { PROVIDER_FLAG_ENV as SERVER_FLAG_ENV, providerFlagOn } from '../../../server/server/config'
import { unitName } from '../../../server/server/autostart'
import {
  providerStateLabel, providerStateDot, providerCredentialMask, refusalMessage, testResultSentence,
  validateProviderForm, buildProviderPutBody, filterModels, modelsFetchedSentence, clearTestState,
  providerOffGuide, SYSTEMD_BUS_CAVEAT, PROVIDER_FLAG_ENV, PROVIDER_FLAG_VALUE, PROVIDER_SERVICE_UNIT,
  type ProviderEntry, type ProviderModel, type TestStateMap,
} from './providerSettings'

// ---------------------------------------------------------------------------------------------
// Row display
// ---------------------------------------------------------------------------------------------

test('providerStateLabel: every state has an EN and PT sentence', () => {
  expect(providerStateLabel('present', false)).toBe('Configured')
  expect(providerStateLabel('present', true)).toBe('Configurado')
  expect(providerStateLabel('absent', false)).toBe('Not configured')
  expect(providerStateLabel('unreadable', false)).toBe('Unreadable')
  expect(providerStateLabel('permissions-too-open', true)).toBe('Permissões abertas demais')
})

test('providerStateDot maps into the existing StatusDot vocabulary', () => {
  expect(providerStateDot('present')).toBe('ok')
  expect(providerStateDot('absent')).toBe('unknown')
  expect(providerStateDot('unreadable')).toBe('error')
  expect(providerStateDot('permissions-too-open')).toBe('warn')
})

test('providerCredentialMask: both fields present', () => {
  expect(providerCredentialMask({ fingerprint: '1a2b3c', last4: 'abcd' })).toBe('…abcd · fp 1a2b3c')
})

test('providerCredentialMask: only last4', () => {
  expect(providerCredentialMask({ last4: 'abcd' })).toBe('…abcd')
})

test('providerCredentialMask: only fingerprint', () => {
  expect(providerCredentialMask({ fingerprint: '1a2b3c' })).toBe('fp 1a2b3c')
})

test('providerCredentialMask: neither field -> null, never a placeholder that looks like data', () => {
  expect(providerCredentialMask({})).toBeNull()
})

// ---------------------------------------------------------------------------------------------
// Refusal localization
// ---------------------------------------------------------------------------------------------

test('refusalMessage: exact code, localized both ways', () => {
  expect(refusalMessage({ code: 'central', sentence: 'x' }, false)).toBe(
    'A central has no local runtime, so there is nothing here to configure.',
  )
  expect(refusalMessage({ code: 'central', sentence: 'x' }, true)).toBe(
    'Uma central não tem runtime local, então não há nada aqui para configurar.',
  )
})

test('refusalMessage: key_* and base_url_* families resolve to a generic sentence naming the field', () => {
  expect(refusalMessage({ code: 'key_empty', sentence: 'x' }, false)).toBe('The key was refused.')
  expect(refusalMessage({ code: 'key_malformed', sentence: 'x' }, true)).toBe('A chave foi recusada.')
  expect(refusalMessage({ code: 'base_url_invalid', sentence: 'x' }, false)).toBe('The base URL was refused.')
})

test('refusalMessage: key_required is its OWN exact entry, not swallowed by the key_ prefix', () => {
  expect(refusalMessage({ code: 'key_required', sentence: 'x' }, false)).toBe('An API key is required.')
})

test('refusalMessage (UI.4): key_required_new_origin says WHY the key is needed again, in both languages', () => {
  // Without an exact entry the key_ family would answer "The key was refused." — a sentence about a
  // key nobody typed. The server refuses moving a stored key to another host without the key.
  expect(refusalMessage({ code: 'key_required_new_origin', sentence: 'x' }, false)).toBe(
    'The stored key stays with the address it was entered for — enter the key again to use a different host.',
  )
  expect(refusalMessage({ code: 'key_required_new_origin', sentence: 'x' }, true)).toBe(
    'A chave salva fica presa ao endereço em que foi cadastrada — digite a chave de novo para usar outro host.',
  )
})

test('refusalMessage: unknown code falls back to the server sentence', () => {
  expect(refusalMessage({ code: 'something-new', sentence: 'A weird thing happened.' }, false)).toBe('A weird thing happened.')
  expect(refusalMessage({ code: 'something-new', sentence: 'A weird thing happened.' }, true)).toBe('A weird thing happened.')
})

test('refusalMessage: /test and /models can answer with the row\'s own state as the refusal code', () => {
  expect(refusalMessage({ code: 'unreadable', sentence: 'x' }, false)).toBe('The stored credential could not be read.')
  expect(refusalMessage({ code: 'permissions-too-open', sentence: 'x' }, true)).toBe(
    'O arquivo da credencial salva tem permissões abertas demais para confiar nele.',
  )
})

test('refusalMessage: server deviations (bad_request, write_failed, etc.) fall back to the sentence, not garbled', () => {
  expect(refusalMessage({ code: 'bad_request', sentence: 'The body was not valid JSON.' }, false)).toBe('The body was not valid JSON.')
  expect(refusalMessage({ code: 'too_large', sentence: 'The request body was too large.' }, false)).toBe('The request body was too large.')
})

test('refusalMessage: base_url_not_editable and key_and_no_key resolve through the generic families', () => {
  expect(refusalMessage({ code: 'base_url_not_editable', sentence: 'x' }, false)).toBe('The base URL was refused.')
  expect(refusalMessage({ code: 'key_and_no_key', sentence: 'x' }, false)).toBe('The key was refused.')
})

test('refusalMessage: unknown code with no sentence falls back to the code itself, never blank', () => {
  expect(refusalMessage({ code: 'something-new', sentence: '' }, false)).toBe('something-new')
})

test('testResultSentence: ok result states a count and latency, singular vs plural', () => {
  expect(testResultSentence({ ok: true, modelCount: 1, latencyMs: 120 }, false)).toBe('Connected — 1 model, 120ms')
  expect(testResultSentence({ ok: true, modelCount: 3, latencyMs: 87 }, false)).toBe('Connected — 3 models, 87ms')
  expect(testResultSentence({ ok: true, modelCount: 3, latencyMs: 87 }, true)).toBe('Conectado — 3 modelos, 87ms')
})

// ---------------------------------------------------------------------------------------------
// keyChecked — a "test connection" that hit a keyless model-list endpoint (openrouter/litellm/
// 9router) proves the endpoint answers, never that a stored key is valid; the sentence must say so
// plainly rather than implying the key was checked (a browser configured with a fake OpenRouter key
// once read "Connected — 458 models" as if it had been).
// ---------------------------------------------------------------------------------------------

test('testResultSentence: keyChecked "yes" states the key was accepted, both languages', () => {
  expect(testResultSentence({ ok: true, modelCount: 3, latencyMs: 87, keyChecked: 'yes' }, false))
    .toBe('Connected — key accepted — 3 models, 87ms')
  expect(testResultSentence({ ok: true, modelCount: 3, latencyMs: 87, keyChecked: 'yes' }, true))
    .toBe('Conectado — chave aceita — 3 modelos, 87ms')
})

test('testResultSentence: keyChecked "no" says the endpoint answered but the key was not validated', () => {
  const en = testResultSentence({ ok: true, modelCount: 458, latencyMs: 340, keyChecked: 'no' }, false)
  expect(en).toContain('458 models')
  expect(en.toLowerCase()).toContain('does not')
  expect(en.toLowerCase()).toContain('key')
  expect(en.toLowerCase()).toMatch(/first (real )?request/)
  const pt = testResultSentence({ ok: true, modelCount: 458, latencyMs: 340, keyChecked: 'no' }, true)
  expect(pt).toContain('458 modelos')
  expect(pt.toLowerCase()).toContain('não confirma')
})

test('testResultSentence: keyChecked "keyless" says no key is stored, both languages', () => {
  const en = testResultSentence({ ok: true, modelCount: 5, latencyMs: 12, keyChecked: 'keyless' }, false)
  expect(en.toLowerCase()).toContain('no key')
  const pt = testResultSentence({ ok: true, modelCount: 5, latencyMs: 12, keyChecked: 'keyless' }, true)
  expect(pt.toLowerCase()).toContain('nenhuma chave')
})

test('testResultSentence: keyChecked absent (older server) reads exactly as before', () => {
  expect(testResultSentence({ ok: true, modelCount: 3, latencyMs: 87 }, false)).toBe('Connected — 3 models, 87ms')
})

test('testResultSentence: refused result reuses refusalMessage', () => {
  expect(testResultSentence({ ok: false, code: 'unauthorized', sentence: 'x' }, false)).toBe('The provider rejected the stored key.')
})

// ---------------------------------------------------------------------------------------------
// Form validation — mirrors the server's own rules so a bad submit is caught before the network
// ---------------------------------------------------------------------------------------------

const editableNoDefault = { baseUrlEditable: true, defaultBaseUrl: null, keyOptional: false, state: 'absent' as const }
const editableWithDefault = { baseUrlEditable: true, defaultBaseUrl: 'https://api.example.com', keyOptional: false, state: 'absent' as const }
const notEditable = { baseUrlEditable: false, defaultBaseUrl: null, keyOptional: false, state: 'absent' as const }
const keyOptionalRules = { baseUrlEditable: true, defaultBaseUrl: 'http://localhost:11434', keyOptional: true, state: 'absent' as const }

test('validateProviderForm: base URL required when the provider has no default and none was typed', () => {
  const v = validateProviderForm({ baseUrl: '', hasKeyTyped: true, noKey: false }, editableNoDefault)
  expect(v).toEqual({ ok: false, code: 'base_url_required' })
})

test('validateProviderForm: base URL not required when a default exists', () => {
  const v = validateProviderForm({ baseUrl: '', hasKeyTyped: true, noKey: false }, editableWithDefault)
  expect(v.ok).toBe(true)
})

test('validateProviderForm: base URL not required when the provider stores none at all (anthropic)', () => {
  const v = validateProviderForm({ baseUrl: '', hasKeyTyped: true, noKey: false }, notEditable)
  expect(v.ok).toBe(true)
})

test('validateProviderForm: key required when nothing is stored and nothing was typed', () => {
  const v = validateProviderForm({ baseUrl: 'https://x', hasKeyTyped: false, noKey: false }, editableWithDefault)
  expect(v).toEqual({ ok: false, code: 'key_required' })
})

test('validateProviderForm: key NOT required when a key is already stored and the field is left blank', () => {
  const v = validateProviderForm(
    { baseUrl: '', hasKeyTyped: false, noKey: false },
    { ...editableWithDefault, state: 'present' },
  )
  expect(v.ok).toBe(true)
})

test('validateProviderForm: key NOT required when noKey is checked and the provider allows it (ollama)', () => {
  const v = validateProviderForm({ baseUrl: '', hasKeyTyped: false, noKey: true }, keyOptionalRules)
  expect(v.ok).toBe(true)
})

test('validateProviderForm: noKey checked but the provider does NOT allow keyless still refuses', () => {
  const v = validateProviderForm({ baseUrl: 'https://x', hasKeyTyped: false, noKey: true }, editableWithDefault)
  expect(v).toEqual({ ok: false, code: 'key_required' })
})

// ---------------------------------------------------------------------------------------------
// PUT body — never carries a key that was not actually typed
// ---------------------------------------------------------------------------------------------

test('buildProviderPutBody: base URL trimmed and included only when editable', () => {
  expect(buildProviderPutBody({ baseUrl: '  https://x  ', baseUrlEditable: true, keyTyped: '', noKey: false, keyOptional: false }))
    .toEqual({ baseUrl: 'https://x' })
})

test('buildProviderPutBody: base URL omitted entirely when the provider does not store one', () => {
  expect(buildProviderPutBody({ baseUrl: 'https://x', baseUrlEditable: false, keyTyped: '', noKey: false, keyOptional: false }))
    .toEqual({})
})

test('buildProviderPutBody: an empty key field omits `key` (server keeps the stored one)', () => {
  expect(buildProviderPutBody({ baseUrl: '', baseUrlEditable: false, keyTyped: '', noKey: false, keyOptional: false }))
    .toEqual({})
})

test('buildProviderPutBody: a typed key is included verbatim', () => {
  expect(buildProviderPutBody({ baseUrl: '', baseUrlEditable: false, keyTyped: 'sk-secret', noKey: false, keyOptional: false }))
    .toEqual({ key: 'sk-secret' })
})

test('buildProviderPutBody: noKey only travels when nothing was typed and the provider allows it', () => {
  expect(buildProviderPutBody({ baseUrl: '', baseUrlEditable: false, keyTyped: '', noKey: true, keyOptional: true }))
    .toEqual({ noKey: true })
})

test('buildProviderPutBody: a typed key wins over a checked noKey box', () => {
  expect(buildProviderPutBody({ baseUrl: '', baseUrlEditable: false, keyTyped: 'sk-secret', noKey: true, keyOptional: true }))
    .toEqual({ key: 'sk-secret' })
})

test('buildProviderPutBody: noKey is dropped when the provider does not allow keyless', () => {
  expect(buildProviderPutBody({ baseUrl: '', baseUrlEditable: false, keyTyped: '', noKey: true, keyOptional: false }))
    .toEqual({})
})

// ---------------------------------------------------------------------------------------------
// Models list
// ---------------------------------------------------------------------------------------------

const models: ProviderModel[] = [
  { id: 'claude-opus-5', ownedBy: 'anthropic', contextLength: 200_000 },
  { id: 'gpt-5', ownedBy: 'openai' },
  { id: 'llama-3-70b', ownedBy: 'meta' },
]

test('filterModels: empty query returns everything', () => {
  expect(filterModels(models, '')).toEqual(models)
  expect(filterModels(models, '   ')).toEqual(models)
})

test('filterModels: matches by id', () => {
  expect(filterModels(models, 'opus').map(m => m.id)).toEqual(['claude-opus-5'])
})

test('filterModels: matches by ownedBy, case-insensitive', () => {
  expect(filterModels(models, 'OpenAI').map(m => m.id)).toEqual(['gpt-5'])
})

test('filterModels: no match returns an empty list', () => {
  expect(filterModels(models, 'nonexistent')).toEqual([])
})

test('modelsFetchedSentence: live vs cached, just now', () => {
  const now = Date.parse('2026-09-27T12:00:00Z')
  expect(modelsFetchedSentence('2026-09-27T12:00:00Z', false, false, now)).toBe('live, updated just now')
  expect(modelsFetchedSentence('2026-09-27T12:00:00Z', true, false, now)).toBe('from cache, updated just now')
})

test('modelsFetchedSentence: minutes and hours, both languages', () => {
  const now = Date.parse('2026-09-27T12:10:00Z')
  expect(modelsFetchedSentence('2026-09-27T12:00:00Z', false, false, now)).toBe('live, updated 10 min ago')
  expect(modelsFetchedSentence('2026-09-27T12:00:00Z', false, true, now)).toBe('ao vivo, atualizado há 10 min')
  const laterNow = Date.parse('2026-09-27T15:00:00Z')
  expect(modelsFetchedSentence('2026-09-27T12:00:00Z', false, false, laterNow)).toBe('live, updated 3h ago')
})

test('modelsFetchedSentence: an unparsable timestamp reads as "just now" rather than throwing', () => {
  const now = Date.now()
  expect(modelsFetchedSentence('not-a-date', false, false, now)).toBe('live, updated just now')
})

// ---------------------------------------------------------------------------------------------
// clearTestState — a "Connected — N models" reading must not survive the credential it described.
// Removing the provider, or replacing its credential, invalidates whatever the old test proved.
// ---------------------------------------------------------------------------------------------

test('clearTestState: drops the named provider\'s entry and leaves the others untouched', () => {
  const state: TestStateMap = {
    openrouter: { loading: false, result: { ok: true, modelCount: 458, latencyMs: 340 } },
    anthropic: { loading: false, result: { ok: true, modelCount: 3, latencyMs: 87 } },
  }
  const next = clearTestState(state, 'openrouter')
  expect(next).toEqual({ anthropic: { loading: false, result: { ok: true, modelCount: 3, latencyMs: 87 } } })
  expect('openrouter' in next).toBe(false)
})

test('clearTestState: a provider with no entry is a no-op (same shape, never throws)', () => {
  const state: TestStateMap = { anthropic: { loading: false } }
  expect(clearTestState(state, 'openai')).toEqual(state)
})

test('clearTestState: clearing the only entry leaves an empty map', () => {
  const state: TestStateMap = { ollama: { loading: false, result: { ok: true, modelCount: 5, latencyMs: 12, keyChecked: 'keyless' } } }
  expect(clearTestState(state, 'ollama')).toEqual({})
})

// Sanity: the type import compiles against a full ProviderEntry shape too.
test('ProviderEntry shape smoke test', () => {
  const entry: ProviderEntry = {
    id: 'anthropic', label: 'Anthropic', kind: 'direct', defaultBaseUrl: null,
    baseUrlEditable: false, keyOptional: false, state: 'present',
    fingerprint: 'abc123', last4: 'wxyz', storedAt: '2026-09-01T00:00:00Z',
  }
  expect(entry.id).toBe('anthropic')
})

// ---------------------------------------------------------------------------------------------
// UI.4 — the React sink, asserted over the screen's own SOURCE (there is no DOM test harness here,
// and the properties that matter are structural: where the value may live, not how it renders).
// ---------------------------------------------------------------------------------------------

test('UI.4: the key never enters state, storage, the console or a controlled input, and is cleared before the PUT', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../pages/settings/ProvidersSettings.tsx', import.meta.url), 'utf8')
  const { stripComments } = await import('./stripComments')
  const code = stripComments(src)
  // No persistence anywhere on this screen, and nothing printed.
  for (const needle of ['localStorage', 'sessionStorage', 'indexedDB', 'console.']) expect(code).not.toContain(needle)
  // The key field is UNCONTROLLED: a ref and a defaultValue, never `value=` bound to anything.
  const at = code.indexOf('ref={keyRef}')
  const start = code.lastIndexOf('<input', at)
  const input = at < 0 || start < 0 ? '' : code.slice(start, code.indexOf('/>', at) + 2)
  expect(input).not.toBe('')
  expect(input).toContain('defaultValue=""')
  expect(input).not.toMatch(/\svalue=\{/)
  // Its onChange reports PRESENCE only (a boolean), never the string.
  expect(input).toMatch(/onChange=\{e => setKeyTouched\(e\.currentTarget\.value\.length > 0\)\}/)
  // Autocomplete OFF, and every common password manager told to leave the field alone — a
  // provider key is not a login password to save, suggest or generate (UI.4 N-3).
  expect(input).toContain('autoComplete="off"')
  expect(input).not.toContain('new-password')
  for (const attr of ['data-1p-ignore', 'data-lpignore="true"', 'data-bwignore', 'data-form-type="other"']) {
    expect(input).toContain(attr)
  }
  // The value is read into a LOCAL and the field is cleared before the request goes out.
  const submit = code.slice(code.indexOf('const submitConfigure'), code.indexOf('// ---- test connection'))
  expect(submit.indexOf("inputEl.value = ''")).toBeGreaterThan(-1)
  expect(submit.indexOf("inputEl.value = ''")).toBeLessThan(submit.indexOf('fetch('))
  // No setter anywhere is handed the typed key.
  expect(code).not.toMatch(/set[A-Z]\w*\(\s*keyTyped/)
})

// ---------------------------------------------------------------------------------------------
// The "runtime is off" guide (UI.5) — Settings → Providers must say HOW to turn it on.
// ---------------------------------------------------------------------------------------------

const allCommands = (pt: boolean): string[] =>
  providerOffGuide(pt).sections.flatMap(s => s.steps.map(st => st.command))

test('off guide: the variable name is the server\'s own constant and the value is the one that turns it on', () => {
  expect(PROVIDER_FLAG_ENV).toBe(SERVER_FLAG_ENV)
  // The value must actually be what the server reads as ON, not merely a string that looks right.
  expect(providerFlagOn({ [SERVER_FLAG_ENV]: PROVIDER_FLAG_VALUE })).toBe(true)
  expect(providerFlagOn({})).toBe(false)
})

test('off guide: the unit named is the one `agentop autostart server` installs', () => {
  expect(PROVIDER_SERVICE_UNIT).toBe(unitName('server'))
})

test('off guide: both languages carry the assignment in every place the switch is mentioned', () => {
  const assignment = `${SERVER_FLAG_ENV}=1`
  for (const pt of [false, true]) {
    const g = providerOffGuide(pt)
    expect(g.lead).toContain(assignment)
    expect(refusalMessage({ code: 'flag-off', sentence: '' }, pt)).toContain(assignment)
    const cmds = allCommands(pt)
    expect(cmds.some(c => c.includes(`Environment=${assignment}`))).toBe(true)
    expect(cmds.some(c => c.startsWith(`${assignment} `))).toBe(true)
  }
})

test('off guide: the FOREGROUND path leads and systemd comes second (WSL: systemctl --user may have no bus)', () => {
  for (const pt of [false, true]) {
    const g = providerOffGuide(pt)
    expect(g.sections).toHaveLength(2)
    expect(g.sections[0]!.steps.map(s => s.command)).toEqual([
      `${SERVER_FLAG_ENV}=1 agentop server`,
      `${SERVER_FLAG_ENV}=1 bun run dev`,
    ])
    expect(g.sections[0]!.note).toBeUndefined()
  }
})

test('off guide: the systemd option is edit -> drop-in -> systemctl restart, with the one-sentence bus caveat', () => {
  for (const pt of [false, true]) {
    const sec = providerOffGuide(pt).sections[1]!
    expect(sec.steps.map(s => s.command)).toEqual([
      `systemctl --user edit ${unitName('server')}`,
      `[Service]\nEnvironment=${SERVER_FLAG_ENV}=1`,
      `systemctl --user restart ${unitName('server')}`,
    ])
    // Only offered where `systemctl --user status <unit>` answers, and it says what to do otherwise.
    expect(sec.note).toContain(`systemctl --user status ${unitName('server')}`)
    expect(sec.note).toContain(pt ? SYSTEMD_BUS_CAVEAT.pt : SYSTEMD_BUS_CAVEAT.en)
  }
  expect(SYSTEMD_BUS_CAVEAT.en).toBe('if systemctl says Failed to connect to bus, use the foreground command.')
  expect(SYSTEMD_BUS_CAVEAT.pt).toBe('se o systemctl disser Failed to connect to bus, use o comando em primeiro plano.')
})

test('off guide: `agentop restart server` appears nowhere (it reported success while changing nothing)', () => {
  for (const pt of [false, true]) {
    expect(JSON.stringify(providerOffGuide(pt))).not.toContain('agentop restart')
  }
})

test('off guide: EN and PT are the same shape and the commands are language-free', () => {
  const en = providerOffGuide(false)
  const pt = providerOffGuide(true)
  expect(pt.sections.map(s => s.steps.length)).toEqual(en.sections.map(s => s.steps.length))
  expect(allCommands(true)).toEqual(allCommands(false))
  expect(pt.title).not.toBe(en.title)
  expect(pt.after).not.toBe(en.after)
  for (const g of [en, pt]) {
    for (const s of g.sections) {
      expect(s.heading.length).toBeGreaterThan(0)
      for (const st of s.steps) expect(st.text.length).toBeGreaterThan(0)
    }
  }
})

test('off guide: the old one-line dead end is gone from the flag-off refusal', () => {
  expect(refusalMessage({ code: 'flag-off', sentence: '' }, false)).not.toBe('Runtime providers are turned off on this machine.')
  expect(refusalMessage({ code: 'flag-off', sentence: '' }, true)).not.toBe('Os provedores de runtime estão desligados nesta máquina.')
})
