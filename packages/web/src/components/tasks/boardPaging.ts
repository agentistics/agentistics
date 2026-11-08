/**
 * boardPaging — PURE: how many cards a board column / list band shows at once.
 *
 * One page size for the whole board, remembered per person (`BoardPrefs.pageSize`), and one page
 * INDEX per column held by the view. The index is CLAMPED on every read (`resolveBoardPage`), so a
 * page left pointing past the end after a card moved out corrects itself instead of showing nothing.
 */

export const BOARD_PAGE_SIZES = [10, 25, 50, 100] as const
export type BoardPageSize = (typeof BOARD_PAGE_SIZES)[number]
export const DEFAULT_BOARD_PAGE_SIZE: BoardPageSize = 10

/** A stored size outside the closed set falls back rather than rendering a size nobody offers. */
export function readPageSize(v: unknown): BoardPageSize {
  return BOARD_PAGE_SIZES.includes(v as BoardPageSize) ? (v as BoardPageSize) : DEFAULT_BOARD_PAGE_SIZE
}

export interface BoardPage {
  /** 0-based, clamped to the real range. */
  page: number
  pageCount: number
  /** Index of the first row shown (inclusive) and one past the last (exclusive). */
  start: number
  end: number
  total: number
  /** False when everything fits on one page: the pager is not drawn at all. */
  paged: boolean
}

export function resolveBoardPage(total: number, pageSize: number, requested: number): BoardPage {
  const size = Math.max(1, Math.floor(pageSize) || DEFAULT_BOARD_PAGE_SIZE)
  const count = Math.max(1, Math.ceil(Math.max(0, total) / size))
  const page = Math.min(count - 1, Math.max(0, Math.floor(requested) || 0))
  return {
    page, pageCount: count, total: Math.max(0, total),
    start: page * size, end: Math.min(Math.max(0, total), page * size + size),
    paged: total > size,
  }
}
