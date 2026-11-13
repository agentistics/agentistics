/**
 * S0c — the STORED stage of a status (spec 2026-11-13-entrega-garantida §2.2, §3.5.8). Pure parts.
 */
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TASK_STATUSES, LIVE_STAGES, STATUS_STAGES, canChangeStatusStage, classifyStatusStage, isStatusStage,
  planStatusMigration, planStatusStages, stageOfStatus, storedStageOf, type TaskStatusDef,
} from './taskStatus'

const def = (id: string, label: string, over: Partial<TaskStatusDef> = {}): TaskStatusDef =>
  ({ id, label, color: '#22c55e', protected: false, order: 0, ...over })

describe('vocabulary', () => {
  test('LIVE_STAGES is the Live vocabulary; STATUS_STAGES adds only the explicit `none`', () => {
    expect([...LIVE_STAGES]).toEqual(['queue', 'blocked', 'running', 'qa', 'adjust', 'leader', 'merge', 'ci', 'completed', 'published'])
    expect([...STATUS_STAGES]).toEqual([...LIVE_STAGES, 'none'])
    expect(isStatusStage('leader')).toBe(true)
    expect(isStatusStage('none')).toBe(true)
    expect(isStatusStage('no-leader')).toBe(false)
    expect(isStatusStage('bogus')).toBe(false)
    expect(isStatusStage(undefined)).toBe(false)
  })
  test('stageOfStatus keeps the classification the Live always had (moved, not changed)', () => {
    expect(stageOfStatus('todo')).toBe('queue')
    expect(stageOfStatus('in_progress')).toBe('running')
    expect(stageOfStatus('in_review')).toBe('leader')
    expect(stageOfStatus('done')).toBe('published')
    expect(stageOfStatus('x', 'Review ready')).toBe('leader')
    expect(stageOfStatus('y', 'Shipped')).toBe('published')
    expect(stageOfStatus('z', 'Whatever')).toBeNull()
  })
  test('the seeded defaults carry an explicit stage equal to what the Live derived for them', () => {
    for (const d of DEFAULT_TASK_STATUSES) expect(d.stage, d.id).toBe(stageOfStatus(d.id, d.label) ?? 'none')
  })
  test('a migrated legacy status is born with its stage', () => {
    const plan = planStatusMigration({ existing: [], usedStatusIds: ['backlog', 'abandoned', 'weird_custom'] })!
    const by = Object.fromEntries(plan.map(s => [s.id, s.stage]))
    expect(by.backlog).toBe('queue')
    expect(by.abandoned).toBe('none')
    expect(by.weird_custom).toBe('none')
  })
})

describe('§3.5.8 the stage is stored, never re-derived from the label', () => {
  test('classifyStatusStage derives once; `none` is explicit, not absent', () => {
    expect(classifyStatusStage(def('r', 'Review ready'))).toBe('leader')
    expect(classifyStatusStage(def('w', 'Waiting on client'))).toBe('none')
  })
  test('RELABEL ATTACK: a stored stage survives a label that now reads as another stage', () => {
    const s = def('in_progress', 'In review', { stage: 'running' })
    expect(storedStageOf(s)).toBe('running')
    const plan = planStatusStages([s], undefined)
    expect(plan.statuses[0]!.stage).toBe('running')
    expect(plan.classified).toEqual([]); expect(plan.restored).toEqual([])
  })
  test('a status with no stage is RESTORED from the mirror, never re-derived from its label', () => {
    const s = def('in_progress', 'In review')              // old writer dropped the stage; label was edited meanwhile
    const plan = planStatusStages([s], { in_progress: 'running' })
    expect(plan.statuses[0]!.stage).toBe('running')
    expect(plan.restored).toEqual(['in_progress']); expect(plan.classified).toEqual([])
  })
  test('storedStageOf: `none`, absent and invalid all read as no stage', () => {
    expect(storedStageOf(def('a', 'A', { stage: 'none' }))).toBeNull()
    expect(storedStageOf(def('a', 'A'))).toBeNull()
    expect(storedStageOf(undefined)).toBeNull()
    expect(storedStageOf(def('a', 'A', { stage: 'bogus' as never }))).toBeNull()
  })
  test('absent from both → classified ONCE by stageOfStatus (a status an old binary created: "Shipped" is guarded rank 4, not a door)', () => {
    const plan = planStatusStages([def('shipped', 'Shipped')], {})
    expect(plan.statuses[0]!.stage).toBe('published')
    expect(plan.classified).toEqual(['shipped'])
  })
  test('absent from both and unclassifiable → explicit `none`', () => {
    expect(planStatusStages([def('w', 'Waiting')], {}).statuses[0]!.stage).toBe('none')
  })
  test('an invalid stage on a status or in the mirror is treated as missing', () => {
    const plan = planStatusStages([def('a', 'A', { stage: 'bogus' as never }), def('b', 'QA pass')], { a: 'also-bogus', b: 'nope' })
    expect(plan.statuses.map(s => s.stage)).toEqual(['none', 'qa'])
    expect(plan.restored).toEqual([])
  })
  test('the plan is pure and idempotent', () => {
    const input = [def('r', 'Review ready')]
    const once = planStatusStages(input, undefined)
    expect(input[0]!.stage).toBeUndefined()
    const twice = planStatusStages(once.statuses, undefined)
    expect(twice.statuses).toEqual(once.statuses); expect(twice.classified).toEqual([])
  })
})

describe('status_stage_in_use', () => {
  test('changing the stage of a status in use is refused naming the usage count', () => {
    const r = canChangeStatusStage({ current: 'running', next: 'leader', usageCount: 3 })
    expect(r).toEqual({ ok: false, reason: 'status_stage_in_use', usageCount: 3 })
  })
  test('an unused status may change stage; an unchanged stage is always fine', () => {
    expect(canChangeStatusStage({ current: 'running', next: 'leader', usageCount: 0 })).toEqual({ ok: true })
    expect(canChangeStatusStage({ current: 'running', next: 'running', usageCount: 9 })).toEqual({ ok: true })
  })
  test('an invalid next stage is refused', () => {
    expect(canChangeStatusStage({ current: 'running', next: 'bogus', usageCount: 0 })).toEqual({ ok: false, reason: 'bad_stage' })
  })
})
