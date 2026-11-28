/**
 * SessionChat is too large to mount here, so how it places a composer surface's button is pinned over
 * its source; the behaviour of the two halves is tested in `../EngineSurfaceButtons.composerPlacement.dom.test.tsx`.
 * The tool row draws only the inactive faces, and the active face sits immediately before the
 * Send/Stop slot (owner, 2026-11-27).
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, 'SessionChat.tsx'), 'utf8')
const composerButtons = [...src.matchAll(/<EngineSurfaceButtons placement="composer"[^>]*\/>/g)].map(m => ({ tag: m[0], at: m.index! }))

test('the composer draws the surface button twice: inactive faces in the tool row, the active one by Send', () => {
  expect(composerButtons.length).toBe(2)
  expect(composerButtons.filter(b => b.tag.includes('only="inactive"')).length).toBe(1)
  expect(composerButtons.filter(b => b.tag.includes('only="active"')).length).toBe(1)
})

test('the inactive one sits in the tool row (before the acting group), the active one just before the send slot', () => {
  const inactive = composerButtons.find(b => b.tag.includes('only="inactive"'))!
  const active = composerButtons.find(b => b.tag.includes('only="active"'))!
  const actingGroup = src.indexOf("<div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>")
  const sendSlot = src.indexOf('{stopShown ? (', actingGroup)
  expect(actingGroup).toBeGreaterThan(-1)
  expect(sendSlot).toBeGreaterThan(actingGroup)
  expect(inactive.at).toBeLessThan(actingGroup)
  expect(active.at).toBeGreaterThan(actingGroup)
  expect(active.at).toBeLessThan(sendSlot)
  // Nothing else is rendered between the active face and the send slot.
  const between = src.slice(active.at + active.tag.length, sendSlot)
  expect(between.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\s/g, '')).toBe(')}')
})
