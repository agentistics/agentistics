import { describe, expect, test } from 'bun:test'
import {
  MAX_SESSION_PRESETS, SHELF_PRESET_COUNT, absolutePresetPath, normalizeSessionPresets,
  presetsForShelf, removeSessionPreset, upsertSessionPreset, validatePresetDraft,
  type SessionPreset,
} from './sessionPresets'

const preset = (over: Partial<SessionPreset> = {}): SessionPreset => ({
  id: 'p1', label: 'Fix flaky tests', harness: 'claude', promptTemplate: 'Find and fix the flaky test',
  ...over,
})

describe('absolutePresetPath', () => {
  test('accepts a POSIX-absolute path', () => {
    expect(absolutePresetPath('/home/user/repo')).toBe(true)
  })
  test('rejects a relative path', () => {
    expect(absolutePresetPath('repo')).toBe(false)
    expect(absolutePresetPath('./repo')).toBe(false)
  })
  test('rejects a NUL byte, which truncates the path in every syscall that receives it', () => {
    expect(absolutePresetPath('/home/\0evil')).toBe(false)
  })
})

describe('validatePresetDraft', () => {
  const base = { label: 'Fix flaky tests', harness: 'claude', promptTemplate: 'do it' }

  test('a complete draft is valid', () => {
    expect(validatePresetDraft(base)).toEqual({ ok: true })
  })
  test('an empty label is refused', () => {
    expect(validatePresetDraft({ ...base, label: '  ' })).toEqual({ ok: false, issue: 'label' })
  })
  test('no harness is refused', () => {
    expect(validatePresetDraft({ ...base, harness: '' })).toEqual({ ok: false, issue: 'harness' })
  })
  test('no prompt is refused — a preset with nothing to say is not a preset', () => {
    expect(validatePresetDraft({ ...base, promptTemplate: '' })).toEqual({ ok: false, issue: 'prompt' })
  })
  test('a relative cwd is refused, an absent one is fine', () => {
    expect(validatePresetDraft({ ...base, cwd: 'relative/path' })).toEqual({ ok: false, issue: 'cwd_relative' })
    expect(validatePresetDraft({ ...base, cwd: undefined })).toEqual({ ok: true })
    expect(validatePresetDraft({ ...base, cwd: '/abs/path' })).toEqual({ ok: true })
  })
})

describe('normalizeSessionPresets', () => {
  test('total: non-array input reads as no presets', () => {
    expect(normalizeSessionPresets(undefined)).toEqual([])
    expect(normalizeSessionPresets(null)).toEqual([])
    expect(normalizeSessionPresets('nope')).toEqual([])
  })

  test('reads a well-formed preset back exactly', () => {
    const raw = [{ id: 'p1', label: 'Fix flaky tests', harness: 'claude', promptTemplate: 'do it', cwd: '/repo', model: 'sonnet', effort: 'high' }]
    expect(normalizeSessionPresets(raw)).toEqual([
      { id: 'p1', label: 'Fix flaky tests', harness: 'claude', promptTemplate: 'do it', cwd: '/repo', model: 'sonnet', effort: 'high' },
    ])
  })

  test('drops a preset missing a required field rather than repairing it', () => {
    const raw = [
      { id: 'p1', label: '', harness: 'claude', promptTemplate: 'do it' },
      { id: 'p2', label: 'ok', harness: '', promptTemplate: 'do it' },
      { id: 'p3', label: 'ok', harness: 'claude', promptTemplate: '' },
      { id: '', label: 'ok', harness: 'claude', promptTemplate: 'do it' },
      { label: 'no id', harness: 'claude', promptTemplate: 'do it' },
    ]
    expect(normalizeSessionPresets(raw)).toEqual([])
  })

  test('drops a preset whose cwd is relative — a half-read preset would launch somewhere nobody chose', () => {
    const raw = [{ id: 'p1', label: 'ok', harness: 'claude', promptTemplate: 'do it', cwd: 'relative' }]
    expect(normalizeSessionPresets(raw)).toEqual([])
  })

  test('trims whitespace and drops empty optional fields', () => {
    const raw = [{ id: 'p1', label: '  ok  ', harness: 'claude', promptTemplate: 'do it', cwd: '   ', model: '  ' }]
    expect(normalizeSessionPresets(raw)).toEqual([{ id: 'p1', label: 'ok', harness: 'claude', promptTemplate: 'do it' }])
  })

  test('caps at MAX_SESSION_PRESETS, keeping the first ones read', () => {
    const raw = Array.from({ length: MAX_SESSION_PRESETS + 5 }, (_, i) => ({
      id: `p${i}`, label: `preset ${i}`, harness: 'claude', promptTemplate: 'do it',
    }))
    const out = normalizeSessionPresets(raw)
    expect(out.length).toBe(MAX_SESSION_PRESETS)
    expect(out[0]!.id).toBe('p0')
  })

  test('a non-object item, or one with no object shape, is skipped rather than throwing', () => {
    expect(normalizeSessionPresets([null, 42, 'x', []])).toEqual([])
  })
})

describe('upsertSessionPreset / removeSessionPreset', () => {
  test('inserts a new preset at the end', () => {
    const list = [preset({ id: 'a' })]
    expect(upsertSessionPreset(list, preset({ id: 'b' })).map(p => p.id)).toEqual(['a', 'b'])
  })

  test('replaces an existing preset IN PLACE — an edit must not move it to the end', () => {
    const list = [preset({ id: 'a' }), preset({ id: 'b' }), preset({ id: 'c' })]
    const next = upsertSessionPreset(list, preset({ id: 'b', label: 'renamed' }))
    expect(next.map(p => p.id)).toEqual(['a', 'b', 'c'])
    expect(next[1]!.label).toBe('renamed')
  })

  test('removes by id and leaves the rest untouched', () => {
    const list = [preset({ id: 'a' }), preset({ id: 'b' })]
    expect(removeSessionPreset(list, 'a').map(p => p.id)).toEqual(['b'])
  })

  test('removing an unknown id is a no-op', () => {
    const list = [preset({ id: 'a' })]
    expect(removeSessionPreset(list, 'nope')).toEqual(list)
  })
})

describe('presetsForShelf', () => {
  test('is a PREFIX, never a re-sort', () => {
    const list = Array.from({ length: 8 }, (_, i) => preset({ id: `p${i}` }))
    expect(presetsForShelf(list).map(p => p.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
    expect(presetsForShelf(list).length).toBe(SHELF_PRESET_COUNT)
  })

  test('fewer presets than the shelf holds all show', () => {
    const list = [preset({ id: 'a' }), preset({ id: 'b' })]
    expect(presetsForShelf(list)).toEqual(list)
  })

  test('a custom limit is honoured', () => {
    const list = Array.from({ length: 8 }, (_, i) => preset({ id: `p${i}` }))
    expect(presetsForShelf(list, 2).map(p => p.id)).toEqual(['p0', 'p1'])
  })
})
