import { describe, expect, test } from 'bun:test'
import {
  NATIVE_HARNESS_ID,
  approveUrl,
  cancelUrl,
  configuredProviders,
  createBody,
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
  test('only a present engine that provides the native runtime opens it', () => {
    expect(nativeRuntimeFrom({ present: true, manifest: { provides: { nativeRuntime: true } } })).toBe(true)
    expect(nativeRuntimeFrom({ present: true, manifest: { provides: { nativeRuntime: false } } })).toBe(false)
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
      { id: 'ollama', label: 'Ollama', state: 'absent', keyless: true },
      { id: 'deepseek', label: 'DeepSeek', state: 'unreadable' },
    ]
    expect(configuredProviders(list).map(p => p.id)).toEqual(['anthropic', 'ollama'])
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
  })

  test('refusalSentence: the engine’s own words, else a sentence per status', () => {
    expect(refusalSentence({ code: 'no_credential', sentence: 'anthropic is not configured' }, 409, 'en')).toBe('anthropic is not configured')
    expect(refusalSentence({ error: 'engine-absent' }, 404, 'en')).toBe('This build has no native runtime.')
    expect(refusalSentence({ code: 'flag-off', sentence: 'x' }, 409, 'pt')).toBe('x')
    expect(refusalSentence(null, 500, 'pt')).toBe('O servidor recusou (500).')
  })
})
