/**
 * Studio.searchExpand.lint.test.ts — closes the review follow-up from the previous UX pass (item 6
 * of this session's own brief): "add a test that FAILS when the line in Studio.tsx's search-request
 * effect that expands a minimized tree is removed."
 *
 * `searchRequestNeedsExpand` (the PURE predicate) already had unit tests before this file existed —
 * `Studio.test.tsx`'s own `describe('searchRequestNeedsExpand — item 8 must never search inside a
 * pane nobody can see', …)`. What was never asserted is that Ctrl+Shift+F's EFFECT actually CALLS
 * it and actually EXPANDS the tree when it says to. There is no jsdom in this repo, so the effect
 * itself cannot be exercised by rendering — the same limitation `StudioHost.lint.test.ts` documents
 * for its own re-parenting effect. This file plays the identical role for this one line: it pins the
 * SHAPE a browser pass (Ctrl+Shift+F over a collapsed tree, confirmed to re-expand it) depends on
 * existing at all.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../../lib/stripComments'

const FILE = join(import.meta.dir, 'Studio.tsx')
const raw = readFileSync(FILE, 'utf8')
const src = stripComments(raw)

describe('the file this reads is the real one', () => {
  it('read something, and read the right thing', () => {
    expect(raw.length).toBeGreaterThan(1_000)
    expect(src).toContain('export function searchRequestNeedsExpand(')
  })
})

describe('the search-request effect actually expands a minimized tree, not only decides it should', () => {
  it('the effect calls setTreeCollapsedState(false) when searchRequestNeedsExpand says so', () => {
    // The EXACT line design item 6 asks to be guarded — a comment-only "TODO: expand" would satisfy
    // a looser grep, which is exactly the defect this repo's own house rules warn against for a
    // source-scan assertion. Matching the real conditional-plus-call, after comments are stripped,
    // is what makes a REMOVED line (or one demoted to a comment) fail this test.
    expect(src).toContain('if (searchRequestNeedsExpand(treeCollapsed)) setTreeCollapsedState(false)')
  })

  it('that line sits inside the search-request useEffect, not somewhere unrelated', () => {
    // Anchors the call to the effect body itself (`if (searchRequest === 0) return` … `setView`)
    // rather than merely somewhere in the file — a copy of the same call pasted into a different,
    // unrelated effect would satisfy the assertion above but fixes nothing.
    expect(src).toMatch(
      /useEffect\(\(\) => \{\s*if \(searchRequest === 0\) return\s*setView\('search'\)\s*if \(searchRequestNeedsExpand\(treeCollapsed\)\) setTreeCollapsedState\(false\)/,
    )
  })

  it('never uses `setTreeCollapsed` (the persisting setter) here — this expands the view only, without overwriting the reader\'s own preference', () => {
    // `setTreeCollapsedState` (raw state, no localStorage write) is deliberate — see the effect's
    // own doc comment. Reaching for the OTHER setter here would silently persist "expanded" as the
    // reader's standing preference the next time they minimize the tree on purpose.
    const m = src.match(/if \(searchRequestNeedsExpand\(treeCollapsed\)\) (\w+)\(false\)/)
    expect(m?.[1]).toBe('setTreeCollapsedState')
  })

  it('the scan actually catches the line being removed — proven against a fabricated snippet', () => {
    const withoutTheLine = `
      useEffect(() => {
        if (searchRequest === 0) return
        setView('search')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [searchRequest])
    `
    const stripped = stripComments(withoutTheLine)
    expect(stripped).not.toContain('if (searchRequestNeedsExpand(treeCollapsed)) setTreeCollapsedState(false)')
  })

  it('the scan actually catches the line being demoted to a comment', () => {
    const commentedOut = `
      useEffect(() => {
        if (searchRequest === 0) return
        setView('search')
        // if (searchRequestNeedsExpand(treeCollapsed)) setTreeCollapsedState(false)
      }, [searchRequest])
    `
    const stripped = stripComments(commentedOut)
    expect(stripped).not.toContain('if (searchRequestNeedsExpand(treeCollapsed)) setTreeCollapsedState(false)')
  })
})
