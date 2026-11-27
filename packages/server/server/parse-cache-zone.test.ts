/**
 * PERF.SERVIDOR-OCIOSO fase 3 (QA C3) — the parse cache's time-zone part is resolved ONCE, not by building an
 * `Intl.DateTimeFormat` per file per build, and still follows a change of `TZ`.
 */
import { afterEach, expect, test } from 'bun:test'
import { localTimeZone } from './parse-cache-jsonl'

const realFormat = Intl.DateTimeFormat
const previous = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
afterEach(() => { (Intl as { DateTimeFormat: unknown }).DateTimeFormat = realFormat; process.env.TZ = previous })

test('a thousand cache lookups build no formatter after the first', () => {
  const zone = localTimeZone()
  let built = 0
  const counting = function (this: unknown, ...a: unknown[]) { built++; return new (realFormat as unknown as new (...x: unknown[]) => Intl.DateTimeFormat)(...a) }
  ;(Intl as { DateTimeFormat: unknown }).DateTimeFormat = counting
  for (let i = 0; i < 1000; i++) expect(localTimeZone()).toBe(zone)
  expect(built).toBe(0)
})

test('a TZ change is followed', () => {
  process.env.TZ = 'America/Sao_Paulo'
  expect(localTimeZone()).toBe('America/Sao_Paulo')
  process.env.TZ = 'Asia/Tokyo'
  expect(localTimeZone()).toBe('Asia/Tokyo')
})
