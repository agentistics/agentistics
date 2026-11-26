import { describe, expect, it } from 'bun:test'
import { modelLabelsOf, modelsOf } from './SubtaskModelCell'
import type { TaskSessionRow } from '../../lib/tasks'

const row = (harness: string, model: string | null): TaskSessionRow => ({ harness, model } as unknown as TaskSessionRow)

describe('modelLabelsOf — the Live card\'s model wording', () => {
  it('reads a Claude transcript id the way the Live card pill does', () => {
    expect(modelLabelsOf([row('claude', 'claude-sonnet-5-5')])).toEqual(['claude · Sonnet 5.5'])
  })
  it('keeps an id no label knows exactly as recorded', () => {
    expect(modelLabelsOf([row('codex', 'gpt-x-unknown')])).toEqual(['codex · gpt-x-unknown'])
  })
  it('dedupes by label and skips sessions with no model', () => {
    expect(modelLabelsOf([row('claude', 'claude-opus-5-5'), row('claude', 'claude-opus-5-5'), row('claude', null)])).toEqual(['claude · Opus 5.5'])
  })
  it('leaves the raw ids to the filter', () => {
    expect(modelsOf([row('claude', 'claude-sonnet-5-5')])).toEqual(['claude-sonnet-5-5'])
  })
})
