import { describe, expect, test } from 'bun:test'
import { BOARD_PAGE_SIZES, DEFAULT_BOARD_PAGE_SIZE, readPageSize, resolveBoardPage } from './boardPaging'

describe('boardPaging', () => {
  test('sizes are the closed set and the default is 10', () => {
    expect([...BOARD_PAGE_SIZES]).toEqual([10, 25, 50, 100])
    expect(DEFAULT_BOARD_PAGE_SIZE).toBe(10)
  })
  test('readPageSize falls back on anything outside the set', () => {
    expect(readPageSize(25)).toBe(25)
    expect(readPageSize(7)).toBe(10)
    expect(readPageSize('50')).toBe(10)
    expect(readPageSize(undefined)).toBe(10)
  })
  test('one page when everything fits: not paged', () => {
    const p = resolveBoardPage(10, 10, 0)
    expect(p).toMatchObject({ page: 0, pageCount: 1, start: 0, end: 10, paged: false })
  })
  test('23 rows at 10 → 3 pages, the last holds 3', () => {
    const p = resolveBoardPage(23, 10, 2)
    expect(p).toMatchObject({ page: 2, pageCount: 3, start: 20, end: 23, paged: true })
  })
  test('a page past the end is clamped, a negative one too', () => {
    expect(resolveBoardPage(23, 10, 9).page).toBe(2)
    expect(resolveBoardPage(23, 10, -3).page).toBe(0)
    expect(resolveBoardPage(0, 10, 4)).toMatchObject({ page: 0, start: 0, end: 0, paged: false })
  })
})
