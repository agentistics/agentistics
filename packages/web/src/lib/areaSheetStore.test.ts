import { afterEach, describe, expect, it } from 'bun:test'
import { getAreaSheetOpen, setAreaSheetOpen } from './areaSheetStore'

afterEach(() => setAreaSheetOpen(false))

describe('areaSheetStore', () => {
  it('holds the flag', () => {
    expect(getAreaSheetOpen()).toBe(false)
    setAreaSheetOpen(true)
    expect(getAreaSheetOpen()).toBe(true)
  })
})
