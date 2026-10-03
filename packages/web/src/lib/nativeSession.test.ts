import { describe, expect, test } from 'bun:test'
import {
  NATIVE_HARNESS_ID,
  approveUrl,
  cancelUrl,
  configuredProviders,
  createBody,
  filingSentence,
  filingUrl,
  nativeHarnessAnswer,
  nativeRuntimeFrom,
  refusalSentence,
  streamUrl,
  windowUrl,
  withNativeHarness,
} from './nativeSession'
import { isNativeSessionId } from './sessionRoute'
import { stepReady, toWizardHarness, type WizardDraft } from './wizardSteps'

describe('nativeRuntimeFrom — the engine gate (GET /api/engine)', () => {
  test('only a present engine that provides the native runtime, with the experimental flag on, opens it', () => {
    expect(nativeRuntimeFrom({ present: true, nativeExperimental: true, manifest: { provides: { nativeRuntime: true } } })).toBe(true)
    // v2.101.0's answer (no flag field): hidden — the native harness is experimental.
    expect(nativeRuntimeFrom({ present: true, manifest: { provides: { nativeRuntime: true } } })).toBe(false)
    expect(nativeRuntimeFrom({ present: true, nativeExperimental: false, manifest: { provides: { nativeRuntime: true } } })).toBe(false)
    expect(nativeRuntimeFrom({ present: true, nativeExperimental: true, manifest: { provides: { nativeRuntime: false } } })).toBe(false)
    expect(nativeRuntimeFrom({ present: false, reason: 'community-build' })).toBe(false)
    expect(nativeRuntimeFrom(null)).toBe(false)
    expect(nativeRuntimeFrom('garbage')).toBe(false)
  })
})

describe('isNativeSessionId — a native session is routed to its own chat', () => {
  test('ses_ + 32 hex; nothing else', () => {
    expect(isNativeSessionId(`ses_${'a1'.repeat(16)}`)).toBe(true)
    expect(isNativeSessionId('ag-claude-1')).toBe(false)
    expect(isNativeSessionId(`ses_${'z'.repeat(32)}`)).toBe(false)
    expect(isNativeSessionId(undefined)).toBe(false)
  })
})

describe('the native harness in the wizard', () => {
  test('added to the list only when the engine provides it, once', () => {
    const base = [{ id: 'claude', label: 'Claude Code', modelSuggestions: [], supportsModel: true, efforts: [] }]
    expect(withNativeHarness(base, false, [])).toEqual(base)
    const withIt = withNativeHarness(base, true, [])
    expect(withIt!.map(h => h.id)).toEqual(['claude', NATIVE_HARNESS_ID])
    expect(withNativeHarness(withIt, true, [])!.filter(h => h.id === NATIVE_HARNESS_ID)).toHaveLength(1)
    expect(withNativeHarness(null, true, [])).toBeNull()
  })

  test('its models are the chosen provider’s, a typed id is accepted, and a model is REQUIRED', () => {
    const h = nativeHarnessAnswer([{ id: 'claude-x', label: 'claude-x' }])
    expect(h).toMatchObject({ id: 'agentistics', label: 'Agentistics', supportsModel: true, modelFreeText: true, modelRequired: true, efforts: [] })
    const draft: WizardDraft = { harness: 'agentistics', cwd: '/w', task: '', model: '', effort: '', prompt: '', label: 'T', attachments: [] }
    expect(stepReady('assistant', draft, toWizardHarness(h))).toEqual({ ok: false, missing: 'model' })
    expect(stepReady('assistant', { ...draft, model: 'claude-x' }, toWizardHarness(h))).toEqual({ ok: true })
  })

  test('configuredProviders: only providers with a usable credential (or keyless)', () => {
    const list = [
      { id: 'anthropic', label: 'Anthropic', state: 'present' },
      { id: 'openai', label: 'OpenAI', state: 'absent' },
      { id: 'ollama', label: 'Ollama', state: 'absent' },
      { id: 'litellm', label: 'LiteLLM', state: 'absent', keyless: true },
      { id: 'deepseek', label: 'DeepSeek', state: 'unreadable' },
    ]
    expect(configuredProviders(list).map(p => p.id)).toEqual(['anthropic', 'ollama', 'litellm'])
  })
})

describe('the native session API', () => {
  const id = `ses_${'b2'.repeat(16)}`
  test('urls', () => {
    expect(windowUrl(id)).toBe(`/api/runtime/sessions/${id}/messages?limit=200`)
    expect(streamUrl(id)).toBe(`/api/runtime/sessions/${id}/stream`)
    expect(streamUrl(id, 12)).toBe(`/api/runtime/sessions/${id}/stream?from=12`)
    expect(approveUrl(id, 'tx_1')).toBe(`/api/runtime/sessions/${id}/tools/tx_1/approve`)
    expect(cancelUrl(id, 'run_1')).toBe(`/api/runtime/sessions/${id}/runs/run_1/cancel`)
  })

  test('createBody', () => {
    expect(createBody({ cwd: '/w', model: 'm', provider: 'anthropic', title: ' T ' })).toEqual({ cwd: '/w', model: 'm', provider: 'anthropic', title: 'T' })
    expect(createBody({ cwd: '/w', model: 'm', provider: '', title: '' })).toEqual({ cwd: '/w', model: 'm' })
    // UI follow-up 2: the filing target, when the wizard's task step named one
    expect(createBody({ cwd: '/w', model: 'm', provider: '', title: '', filing: { taskId: 't-1', subtaskId: 's-1' } }))
      .toEqual({ cwd: '/w', model: 'm', taskId: 't-1', subtaskId: 's-1' })
    expect(createBody({ cwd: '/w', model: 'm', provider: '', title: '', filing: { taskId: 't-1' } })).toEqual({ cwd: '/w', model: 'm', taskId: 't-1' })
  })

  test('refusalSentence: the engine’s own words, else a sentence per status', () => {
    expect(refusalSentence({ code: 'no_credential', sentence: 'anthropic is not configured' }, 409, 'en')).toBe('anthropic is not configured')
    expect(refusalSentence({ error: 'engine-absent' }, 404, 'en')).toBe('This build has no native runtime.')
    expect(refusalSentence({ code: 'flag-off', sentence: 'x' }, 409, 'pt')).toBe('x')
    expect(refusalSentence(null, 500, 'pt')).toBe('O servidor recusou (500).')
  })
})

describe('optionLabel / formatDuration', () => {
  test('the engine’s options in PT; unknown ones pass as is; EN untouched', async () => {
    const { optionLabel, formatDuration, isDenyOption } = await import('./nativeSession')
    expect(optionLabel('Allow once', 'pt')).toBe('Permitir uma vez')
    expect(optionLabel('Deny', 'pt')).toBe('Negar')
    expect(optionLabel('Allow for this session: commands starting with git status', 'pt')).toBe('Permitir nesta sessão: comandos que começam com git status')
    expect(optionLabel('Allow for this session: file.write in src', 'pt')).toBe('Permitir nesta sessão: file.write in src')
    expect(optionLabel('main', 'pt')).toBe('main')
    expect(optionLabel('Allow once', 'en')).toBe('Allow once')
    expect(isDenyOption('Deny')).toBe(true)
    expect(formatDuration(350)).toBe('350 ms')
    expect(formatDuration(1234)).toBe('1.2 s')
  })
})

describe('filing a native session (UI follow-up 2)', () => {
  test('filingUrl', () => {
    expect(filingUrl('ses_1')).toBe('/api/runtime/sessions/ses_1/filing')
  })
  test('filingSentence: nothing when filed; the board\'s reason in words when refused', () => {
    expect(filingSentence({ ok: true, id: 'native:x' }, 'en')).toBeNull()
    expect(filingSentence(undefined, 'en')).toBeNull()
    expect(filingSentence({ ok: false, reason: 'blocked' }, 'en')).toBe('The session started, but was not filed: that subtask is blocked by another one.')
    expect(filingSentence({ ok: false, reason: 'blocked' }, 'pt')).toBe('A sessão começou, mas não foi arquivada: essa subtarefa está bloqueada por outra.')
    expect(filingSentence({ ok: false, reason: 'weird' }, 'en')).toBe('The session started, but was not filed (weird).')
  })
})
