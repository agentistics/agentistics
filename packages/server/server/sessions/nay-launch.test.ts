import { describe, expect, test } from 'bun:test'
import { planNayLaunch, type NayHarnessOption } from './nay-launch'

const H: NayHarnessOption[] = [
  { id: 'claude', supportsModel: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: [{ id: 'opus' }, { id: 'sonnet' }], modelFreeText: false },
  { id: 'codex', supportsModel: true, efforts: [], models: [{ id: 'gpt-5.5' }], modelFreeText: true },
  { id: 'kimi', supportsModel: false, efforts: [], models: [], modelFreeText: false },
]

describe('planNayLaunch', () => {
  test('nothing chosen and nothing saved: claude with the CLI defaults', () => {
    expect(planNayLaunch({}, {}, H)).toEqual({ ok: true, harness: 'claude' })
  })
  test('the Settings defaults are used when the picker changes nothing', () => {
    expect(planNayLaunch({}, { chatHarness: 'claude', chatModel: 'opus', chatEffort: 'high' }, H))
      .toEqual({ ok: true, harness: 'claude', model: 'opus', effort: 'high' })
  })
  test('a legacy chatModel with no chatHarness still applies to claude', () => {
    expect(planNayLaunch({}, { chatModel: 'sonnet' }, H)).toMatchObject({ harness: 'claude', model: 'sonnet' })
  })
  test('the picker wins over the defaults, and an empty string asks for the CLI default', () => {
    expect(planNayLaunch({ model: 'sonnet', effort: '' }, { chatModel: 'opus', chatEffort: 'high' }, H))
      .toEqual({ ok: true, harness: 'claude', model: 'sonnet' })
  })
  test('saved model and effort never ride onto another harness', () => {
    expect(planNayLaunch({ harness: 'codex' }, { chatHarness: 'claude', chatModel: 'opus', chatEffort: 'high' }, H))
      .toEqual({ ok: true, harness: 'codex' })
  })
  test('a stale saved default is dropped quietly, never failing the start', () => {
    expect(planNayLaunch({}, { chatHarness: 'gone', chatModel: 'nope', chatEffort: 'turbo' }, H))
      .toEqual({ ok: true, harness: 'claude' })
  })
  test('an explicit request the machine cannot honour is refused in words', () => {
    expect(planNayLaunch({ harness: 'gemini' }, {}, H)).toEqual({ ok: false, reason: 'unknown_harness', value: 'gemini' })
    expect(planNayLaunch({ effort: 'turbo' }, {}, H)).toEqual({ ok: false, reason: 'unknown_effort', value: 'turbo' })
    expect(planNayLaunch({ harness: 'kimi', model: 'x' }, {}, H)).toEqual({ ok: false, reason: 'no_model_flag', value: 'x' })
  })
  test('a free-text catalog accepts a safe typed id', () => {
    expect(planNayLaunch({}, { chatHarness: 'codex', chatModel: 'gpt-6-preview' }, H)).toMatchObject({ model: 'gpt-6-preview' })
  })
  test('no harness at all is its own refusal', () => {
    expect(planNayLaunch({}, {}, [])).toEqual({ ok: false, reason: 'no_harness' })
  })
})
