import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { RefusalLog } from './refusal-log'

const saved = process.env.SERVE_STATIC
afterEach(() => {
  if (saved === undefined) delete process.env.SERVE_STATIC
  else process.env.SERVE_STATIC = saved
})

describe('server refusal diagnostics', () => {
  test('CLI reads are silent and do not consume a later server diagnostic', () => {
    const log = new RefusalLog()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      delete process.env.SERVE_STATIC
      log.warn('pair', 'refused')
      expect(warn).not.toHaveBeenCalled()
      process.env.SERVE_STATIC = '1'
      log.warn('pair', 'refused')
      log.warn('pair', 'refused')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally { warn.mockRestore() }
  })

  test('more than 512 pairs never evict an earlier diagnostic', () => {
    process.env.SERVE_STATIC = '1'
    const log = new RefusalLog()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < 600; i++) log.warn(`pair-${i}`, `refused ${i}`)
      }
      expect(warn).toHaveBeenCalledTimes(600)
    } finally { warn.mockRestore() }
  })
})
