import { describe, expect, test } from 'bun:test'
import { bandSegmentEntries } from './bandSegment'

const ALL = { cli: true, shell: true, studio: true }

describe('bandSegmentEntries — the band segment always offers all three, occupant lit', () => {
  test('every gate open, occupant cli: all three, cli lit', () => {
    const entries = bandSegmentEntries('cli', ALL)
    expect(entries).toEqual([
      { id: 'cli', on: true },
      { id: 'shell', on: false },
      { id: 'studio', on: false },
    ])
  })

  test('every gate open, occupant shell: all three, shell lit', () => {
    const entries = bandSegmentEntries('shell', ALL)
    expect(entries).toEqual([
      { id: 'cli', on: false },
      { id: 'shell', on: true },
      { id: 'studio', on: false },
    ])
  })

  // The exact regression (screenshot 2): Studio occupying the band used to drop itself from the
  // segment entirely. Plant: revert to filtering `id !== occupant` for the studio row (the old
  // "what else can I switch to" framing) and this fails — studio is missing rather than lit.
  test('every gate open, occupant studio: all three, STUDIO lit — it must not vanish from its own segment', () => {
    const entries = bandSegmentEntries('studio', ALL)
    expect(entries).toEqual([
      { id: 'cli', on: false },
      { id: 'shell', on: false },
      { id: 'studio', on: true },
    ])
  })

  test('shell not offered: two entries, order preserved', () => {
    expect(bandSegmentEntries('cli', { cli: true, shell: false, studio: true })).toEqual([
      { id: 'cli', on: true },
      { id: 'studio', on: false },
    ])
  })

  test('studio not offered (editor gate closed): two entries, neither is studio', () => {
    expect(bandSegmentEntries('shell', { cli: true, shell: true, studio: false })).toEqual([
      { id: 'cli', on: false },
      { id: 'shell', on: true },
    ])
  })

  test('only the occupant offered: one entry, lit', () => {
    expect(bandSegmentEntries('cli', { cli: true, shell: false, studio: false })).toEqual([
      { id: 'cli', on: true },
    ])
  })

  test('exactly one entry is ever lit, across every occupant × offered combination', () => {
    const occupants: Array<'cli' | 'shell' | 'studio'> = ['cli', 'shell', 'studio']
    for (const occupant of occupants) {
      for (const cli of [true, false]) {
        for (const shell of [true, false]) {
          for (const studio of [true, false]) {
            const offered = { cli, shell, studio }
            if (!offered[occupant]) continue // the occupant is always offered in practice
            const entries = bandSegmentEntries(occupant, offered)
            const lit = entries.filter(e => e.on)
            expect(lit).toHaveLength(1)
            expect(lit[0]?.id).toBe(occupant)
          }
        }
      }
    }
  })
})
