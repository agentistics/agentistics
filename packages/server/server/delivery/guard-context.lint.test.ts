import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { isBuildOutput, productionSources, read } from './lint-scan.testing'
import { carryingContext, missingContext, missingContextSites } from './guard-sites.testing'
import { historicInventory, inventoryGrowth } from './guard-inventory.testing'

const PKGS = join(import.meta.dir, '..', '..', '..')
describe('GuardContext call sites (S2c: the allowlist is EMPTY and stays empty)', () => {
  test('the pinned allowlist holds no entry and no production site lacks its context', () => {
    expect(historicInventory().contexts).toEqual({})
    const missing: string[] = []
    for (const rel of productionSources(join(PKGS, 'server'), PKGS).filter(r => !isBuildOutput(r))) {
      for (const id of missingContextSites(read(PKGS, rel))) missing.push(`${rel}:${id}`)
    }
    expect(missing).toEqual([])
  }, 30_000)
  test('every new or changed site must pass a context', () => {
    const actual: Record<string, string[]> = {}
    let carrying = 0
    for (const rel of productionSources(join(PKGS, 'server'), PKGS).filter(r => !isBuildOutput(r))) {
      const src = read(PKGS, rel); actual[rel] = missingContextSites(src); carrying += carryingContext(src)
    }
    expect(inventoryGrowth(actual, historicInventory().contexts)).toEqual([])
    expect(carrying).toBeGreaterThanOrEqual(3) // executable argument sites; textual mentions no longer count
  }, 30_000)
  test('F8 mutants: strings, comments and the wrong position do not pass a context', () => {
    for (const src of [
      "await w.store.upsertTask({ ...task, title: 'guard' })",
      "await w.store.upsertSubtask(s /* guard */)",
      "await w.store.upsertSubtask({ ...s, guard: ctx })",
      "await w.store.patchTask(id, { status }, { allowOpenSubtasks: true })",
      "await d.store.update(doc => { const guard = true })",
    ]) expect(missingContext(src)).toBe(1)
    for (const src of [
      "await w.store.upsertSubtask({ ...s }, guard)",
      "await w.store.patchTask(id, { status }, { guard: o.guard })",
      "await d.store.update(doc => {}, { guard: flowContext() })",
      '// w.store.upsertSubtask(x)\nconst s = "store.update(x)"',
    ]) expect(missingContext(src)).toBe(0)
  })
  test('F8 mutants: same-count replacement and expansion with a raised live allowance are refused', () => {
    const old = missingContextSites('w.store.upsertSubtask(oldPiece)')
    const replacement = missingContextSites('w.store.upsertSubtask(newPiece)')
    expect(inventoryGrowth({ file: replacement }, { file: old })).toHaveLength(1)
    const originalFunction = missingContextSites('function existingDoor() { store.upsertTask(piece) }')
    const differentFunction = missingContextSites('function replacementDoor() { store.upsertTask(piece) }')
    expect(inventoryGrowth({ file: differentFunction }, { file: originalFunction })).toHaveLength(1)
    const baseline = historicInventory().contexts
    const grown = { ...baseline, mutant: missingContextSites('w.store.upsertTask(newPiece)') }
    expect(inventoryGrowth(grown, baseline)).toHaveLength(1)
    expect(inventoryGrowth({ file: [...old, ...old] }, { file: old })).toHaveLength(1)
    expect(inventoryGrowth({}, baseline)).toEqual([])
  })
})
