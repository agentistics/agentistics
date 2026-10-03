import { describe, expect, test } from 'bun:test'
import { PROJECTION_SURFACES_ENV, projectionSurfaceOn, projectionSurfaces } from './projection-surfaces'

describe('projection surfaces (per-surface rollout of the projected read path)', () => {
  test('absent or blank: every surface reads the projections (the default since the backfill item)', () => {
    expect(projectionSurfaces({})).toEqual(['mcp', 'vscode', 'tui', 'web'])
    expect(projectionSurfaceOn('mcp', {})).toBe(true)
    expect(projectionSurfaceOn('tui', { [PROJECTION_SURFACES_ENV]: '  ' })).toBe(true)
  })

  test('"legacy" (the fallback flag, kept for one bundle) puts every surface back on /api/data', () => {
    expect(projectionSurfaces({ [PROJECTION_SURFACES_ENV]: 'legacy' })).toEqual([])
    expect(projectionSurfaceOn('web', { [PROJECTION_SURFACES_ENV]: ' LEGACY ' })).toBe(false)
    // "none" is the same answer, spelled the other way.
    expect(projectionSurfaces({ [PROJECTION_SURFACES_ENV]: 'none' })).toEqual([])
  })

  test('a comma list names the surfaces, trimmed and case-insensitive', () => {
    const env = { [PROJECTION_SURFACES_ENV]: ' MCP , tui' }
    expect(projectionSurfaces(env)).toEqual(['mcp', 'tui'])
    expect(projectionSurfaceOn('mcp', env)).toBe(true)
    expect(projectionSurfaceOn('tui', env)).toBe(true)
    expect(projectionSurfaceOn('web', env)).toBe(false)
  })

  test('unknown names are ignored, not an error; a list of only unknown names is no surface', () => {
    expect(projectionSurfaces({ [PROJECTION_SURFACES_ENV]: 'mcp,desktop,,' })).toEqual(['mcp'])
    expect(projectionSurfaces({ [PROJECTION_SURFACES_ENV]: 'desktop' })).toEqual([])
  })

  test('"all" names every surface', () => {
    expect(projectionSurfaces({ [PROJECTION_SURFACES_ENV]: 'all' })).toEqual(['mcp', 'vscode', 'tui', 'web'])
  })
})

import { metricsSearchParams } from './projection-client'

describe('metrics query parameters', () => {
  test('an array is a repeated parameter, never joined with a comma', () => {
    expect(metricsSearchParams({ project: ['/a,b', '/c'], metrics: 'cost' }).toString()).toBe('project=%2Fa%2Cb&project=%2Fc&metrics=cost')
  })
})
