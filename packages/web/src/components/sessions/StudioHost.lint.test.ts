/**
 * StudioHost.lint.test.ts — the re-parenting mechanism, asserted over the source (design §1.4).
 *
 * There is no jsdom here, so the actual DOM re-parenting this component performs — creating one
 * carrier node and physically `appendChild`-ing it into whichever slot's box currently wants it —
 * cannot be exercised by rendering. The Playwright scenario the design owes (open two files, type in
 * one, move right↔bottom↔right↔bottom, assert the model and the undo stack survive, assert no second
 * `GET /api/fleet/tree`) is what actually proves the mechanism; this file pins the SHAPE the browser
 * evidence depends on existing at all, the same role `monacoEntry.lint.test.ts` plays for the editor
 * bundle. Each check here is a way this component could quietly stop being what its own header says
 * it is, verified with a planted defect.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../../lib/stripComments'

const FILE = join(import.meta.dir, 'StudioHost.tsx')
const raw = readFileSync(FILE, 'utf8')
const src = stripComments(raw)
const has = (needle: string) => src.includes(needle)

describe('the file this reads is the real one', () => {
  it('read something, and read the right thing', () => {
    expect(raw.length).toBeGreaterThan(1_000)
    expect(has('export function StudioHost(')).toBe(true)
  })
})

describe('the carrier is created ONCE and never replaced', () => {
  it('the creation is guarded by a null check on the ref itself', () => {
    // A carrier created unconditionally (or inside an effect with a dependency) would be a NEW node
    // on some later render — exactly the re-parenting-by-recreation this component exists to avoid.
    expect(has('if (carrierRef.current === null) {')).toBe(true)
  })

  it('createPortal renders into that same ref, not a fresh element', () => {
    expect(has('createPortal(<Studio {...studioProps} />, carrierRef.current)')).toBe(true)
  })

  it('the scan still sees the carrier being recreated', () => {
    const recreated = 'const carrier = document.createElement(\'div\')\ncreatePortal(<Studio />, carrier)'
    expect(stripComments(recreated)).not.toContain('if (carrierRef.current === null) {')
  })
})

describe('the move is a real DOM re-parent, not a conditional render', () => {
  it('the effect appendChilds the SAME carrier node into the target', () => {
    expect(has('dest.appendChild(carrier)')).toBe(true)
  })

  it('it runs on every commit rather than only when `target` changes', () => {
    // A `[target]` dependency array would miss the very first attach, where the parking div's own
    // ref has only just been set by the same commit.
    expect(src).toMatch(/useEffect\(\(\) => \{\s*const carrier = carrierRef\.current\s*const dest = target[\s\S]{0,400}?\}\)(?!\s*,\s*\[)/)
  })

  it('the scan still sees a dependency array sneaking back in', () => {
    const withDeps = 'useEffect(() => {\n  const carrier = carrierRef.current\n  const dest = target ?? parkRef.current\n}, [target])'
    expect(withDeps).not.toMatch(/useEffect\(\(\) => \{\s*const carrier = carrierRef\.current\s*const dest = target[\s\S]{0,400}?\}\)(?!\s*,\s*\[)/)
  })
})

describe('a null target parks the Studio rather than unmounting it', () => {
  it('the park is a real element this component renders, not a bare detach', () => {
    expect(has('ref={parkRef}')).toBe(true)
    expect(has('inert')).toBe(true)
  })

  it('parking never uses display:none or visibility — the hiding rules `Layer` already states', () => {
    expect(src).not.toMatch(/display:\s*['"]none['"]/)
    expect(src).not.toMatch(/visibility:/)
  })
})
