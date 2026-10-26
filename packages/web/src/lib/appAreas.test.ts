import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_AREAS, UNLISTED_ROUTES, areaOfPath, isSessionsWorkspace, searchAreas, firstPath } from './appAreas'

describe('areaOfPath', () => {
  for (const [path, page] of [['/leadership', 'leaders'], ['/leadership/checkins', 'checkins'],
    ['/leadership/handoffs', 'handoffs'], ['/leadership/away', 'away']] as const) {
    test(`${path} remains a deep link in Sessions without becoming a terminal workspace`, () => {
      expect(areaOfPath(path)?.area.id).toBe('sessions')
      expect(areaOfPath(path)?.page?.id).toBe(page)
      expect(isSessionsWorkspace(path)).toBe(false)
      expect(searchAreas(page === 'leaders' ? 'Líderes' : page === 'handoffs' ? 'Passagens' : page === 'away' ? 'Away' : 'Check-ins', 'en').some(r => r.area.id === 'sessions' && r.page.path === path)).toBe(true)
    })
  }
  test('sessions and everything under it', () => {
    expect(areaOfPath('/sessions')?.area.id).toBe('sessions')
    expect(areaOfPath('/sessions/3b84a922/terminal')?.area.id).toBe('sessions')
    expect(isSessionsWorkspace('/sessions')).toBe(true)
    expect(isSessionsWorkspace('/sessions/3b84a922/terminal')).toBe(true)
    expect(isSessionsWorkspace('/sessions-report')).toBe(false)
  })
  test('a lookalike prefix is not the area', () => {
    expect(areaOfPath('/sessions-report')).toBeNull()
    expect(areaOfPath('/usagex')).toBeNull()
  })
  test('subpages resolve to the most specific page', () => {
    expect(areaOfPath('/usage')?.page?.id).toBe('now')
    expect(areaOfPath('/usage/history')?.page?.id).toBe('history')
    expect(areaOfPath('/leadership/away')?.page?.id).toBe('away')
    expect(areaOfPath('/tasks/activity')?.page?.id).toBe('activity')
    expect(areaOfPath('/tasks/t-123')?.page?.id).toBe('board')
    expect(areaOfPath('/repositories/actions')?.page?.id).toBe('actions')
    expect(areaOfPath('/repo/abc')?.page?.id).toBe('list')
  })
  test('metrics owns the root and its pages', () => {
    expect(areaOfPath('/')?.area.id).toBe('metrics')
    expect(areaOfPath('/')?.page?.id).toBe('overview')
    expect(areaOfPath('/costs')?.page?.id).toBe('costs')
    expect(areaOfPath('/tags/x')?.page?.id).toBe('tags')
  })
  test('settings is an area whose subpages are the settings sections (A1)', () => {
    expect(areaOfPath('/settings/preferences')?.area.id).toBe('settings')
    expect(areaOfPath('/settings/pricing')?.page?.id).toBe('pricing')
    expect(areaOfPath('/settings')?.area.id).toBe('settings')
    expect(firstPath(APP_AREAS.find(a => a.id === 'settings')!)).toBe('/settings/preferences')
  })
})

describe('registry shape', () => {
  test('ids are unique and every area has a label in both languages', () => {
    const ids = APP_AREAS.map(a => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const a of APP_AREAS) {
      expect(a.labelPt.length > 0 && a.labelEn.length > 0).toBe(true)
      for (const p of a.pages) expect(p.labelPt.length > 0 && p.labelEn.length > 0).toBe(true)
    }
  })
  test('order is the owner-approved one', () => {
    expect(APP_AREAS.map(a => a.id)).toEqual(['metrics', 'sessions', 'tasks', 'usage', 'repositories', 'vault', 'settings'])
  })
})

describe('every router path is in the registry or explicitly unlisted', () => {
  test('AppRouter coverage', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'AppRouter.tsx'), 'utf8')
    const paths = [...src.matchAll(/<Route\s+path="([^"]+)"/g)].map(m => m[1]!)
      .filter(p => !p.includes('*'))
    const nested = new Set(['preferences', 'accessibility', 'notifications', 'sessions', 'data-sources', 'backup',
      'harnesses', 'pricing', 'billing', 'install', 'whatsnew', 'live', 'chat', 'vault', 'providers', 'memory', 'teams'])
    for (const p of paths) {
      const abs = '/' + p.replace(/:\w+/g, 'x')
      const known = areaOfPath(abs) !== null || UNLISTED_ROUTES.includes(p) || nested.has(p)
      if (!known) throw new Error(`route "${p}" is in no area and not in UNLISTED_ROUTES`)
    }
  })
})

describe('searchAreas', () => {
  test('accent-insensitive, both languages', () => {
    expect(searchAreas('historico', 'pt').map(r => r.page.id)).toContain('history')
    expect(searchAreas('away', 'pt').map(r => r.page.id)).toContain('away')
  })
  test('empty query finds nothing', () => {
    expect(searchAreas('  ', 'pt')).toEqual([])
  })
})

describe('firstPath', () => {
  test('Sessions defaults to its workspace and remembers its leadership pages', () => {
    const sessions = APP_AREAS.find(a => a.id === 'sessions')!
    expect(firstPath(sessions)).toBe('/sessions')
    expect(firstPath(sessions, '/leadership/checkins')).toBe('/leadership/checkins')
  })
  test('the remembered page wins only when it belongs to the area', () => {
    const usage = APP_AREAS.find(a => a.id === 'usage')!
    expect(firstPath(usage)).toBe('/usage')
    expect(firstPath(usage, '/usage/plan')).toBe('/usage/plan')
    expect(firstPath(usage, '/costs')).toBe('/usage')
  })
})
