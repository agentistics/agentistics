import { describe, expect, test } from 'bun:test'
import type { AgentSchedule } from '@agentistics/core'
import { agentUseChanges, agentUseNow, agentUsePatch, draftOf, sameDraft, unsavedCountText, type AgentUseDraft } from './agentUseDraft'

const sched: AgentSchedule = { enabled: true, days: { mon: { windows: [{ from: '09:00', to: '18:00' }] }, wed: { windows: [{ from: '09:00', to: '18:00' }] } } }
const saved: AgentUseDraft = { enabled: true, override: false, schedule: sched }
const withDay = (s: AgentSchedule, day: 'sat', w: { from: string; to: string }[]): AgentSchedule => ({ ...s, days: { ...s.days, [day]: { windows: w } } })

describe('draftOf — the drawer opens with what the server says', () => {
  test('reads the two switches from the server view, else from `available`', () => {
    expect(draftOf({ available: false, agentSchedule: sched, agentUse: { reason: 'agenda-off', on: false, enabled: false, override: true, dayUsedPct: null } }))
      .toMatchObject({ enabled: false, override: true })
    expect(draftOf({ available: true })).toMatchObject({ enabled: true, override: false })
    expect(draftOf({ available: false })).toMatchObject({ enabled: false, override: false })
  })
  test('an account with no schedule starts from the default weekdays 09-18, active', () => {
    const d = draftOf({ available: true })
    expect(Object.keys(d.schedule.days)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri'])
    expect(d.schedule.enabled).toBe(true)
  })
})

describe('agentUsePatch — one request, only what changed', () => {
  test('nothing changed → null', () => {
    expect(agentUsePatch(saved, { ...saved })).toBeNull()
    expect(sameDraft(saved, { ...saved })).toBe(true)
  })
  test('each field on its own', () => {
    expect(agentUsePatch(saved, { ...saved, enabled: false })).toEqual({ agentUseEnabled: false })
    expect(agentUsePatch(saved, { ...saved, override: true })).toEqual({ agentOverride: true })
  })
  test('an edited schedule travels ACTIVE; unchanged switches stay out', () => {
    // The draft's own `enabled` flag may be false (a default schedule never saved): the PATCH still sends it active.
    const next = { ...saved, schedule: { ...withDay(sched, 'sat', [{ from: '10:00', to: '14:00' }]), enabled: false } }
    const patch = agentUsePatch(saved, next)!
    expect(patch.agentSchedule!.enabled).toBe(true)
    expect(patch).toEqual({ agentSchedule: { ...next.schedule, enabled: true } })
  })
  test('everything together is still ONE object', () => {
    const next = { enabled: false, override: true, schedule: withDay(sched, 'sat', [{ from: '10:00', to: '14:00' }]) }
    expect(Object.keys(agentUsePatch(saved, next)!).sort()).toEqual(['agentOverride', 'agentSchedule', 'agentUseEnabled'])
  })
})

describe('agentUseChanges — what changed, in words', () => {
  test('nothing → empty', () => expect(agentUseChanges(saved, { ...saved }, 'pt')).toEqual([]))
  test('the switches, PT', () => {
    expect(agentUseChanges(saved, { ...saved, override: true }, 'pt')).toEqual(['Sobrescrever a agenda: desligado → ligado'])
    expect(agentUseChanges(saved, { ...saved, enabled: false }, 'pt')).toEqual(['Agenda: ligado → desligado'])
  })
  test('a day joining and leaving the schedule', () => {
    const joined = withDay(sched, 'sat', [{ from: '10:00', to: '14:00' }])
    expect(agentUseChanges(saved, { ...saved, schedule: joined }, 'pt')).toEqual(['Sábado entrou na agenda (10:00–14:00)'])
    expect(agentUseChanges({ ...saved, schedule: joined }, saved, 'pt')).toEqual(['Sábado saiu da agenda'])
    expect(agentUseChanges(saved, { ...saved, schedule: joined }, 'en')).toEqual(['Saturday joined the schedule (10:00–14:00)'])
  })
  test('several ranges on one day', () => {
    const next = { ...saved, schedule: { ...sched, days: { ...sched.days, wed: { windows: [{ from: '08:00', to: '12:00' }, { from: '14:00', to: '20:00' }] } } } }
    expect(agentUseChanges(saved, next, 'pt')).toEqual(['Quarta: 09:00–18:00 → 08:00–12:00, 14:00–20:00'])
  })
  test('ceilings', () => {
    expect(agentUseChanges(saved, { ...saved, schedule: { ...sched, maxWeeklyPct: 60 } }, 'pt')).toEqual(['Teto da semana: sem teto → 60%'])
  })
  test('the count line', () => {
    expect(unsavedCountText(0, 'pt')).toBe('')
    expect(unsavedCountText(1, 'pt')).toBe('1 alteração não salva')
    expect(unsavedCountText(3, 'pt')).toBe('3 alterações não salvas')
    expect(unsavedCountText(2, 'en')).toBe('2 unsaved changes')
  })
})

describe('agentUseNow — the "Agora" line', () => {
  const view = { reason: 'in-window' as const, on: true, enabled: true, override: false, dayUsedPct: null }
  test('agenda off wins, then override, then the server reason', () => {
    expect(agentUseNow(view, { enabled: false, override: true }, 'pt')).toMatchObject({ kind: 'off', text: 'Agentes não usam esta conta' })
    expect(agentUseNow(view, { enabled: true, override: true }, 'pt')).toMatchObject({ kind: 'free' })
    expect(agentUseNow(view, { enabled: true, override: false }, 'pt')).toMatchObject({ kind: 'ok', text: 'Liberada pela agenda' })
  })
  test('a server "off by schedule" reads as off, not green', () => {
    expect(agentUseNow({ ...view, reason: 'outside-window', on: false }, { enabled: true, override: false }, 'pt').kind).toBe('off')
  })
  test('once a switch moved in the draft, the line does not claim the old server verdict', () => {
    const stale = { ...view, reason: 'override-on' as const, enabled: true, override: true }
    expect(agentUseNow(stale, { enabled: true, override: false }, 'pt')).toMatchObject({ kind: 'ok', text: 'Segue a agenda' })
  })
})
