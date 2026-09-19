/**
 * stripComments.ts — the ONE comment stripper the source-scanning lint tests read through.
 *
 * A lint test that greps source has one trap, and this package has fallen into it three times: **a
 * file that documents a rule necessarily contains, in prose, the very shape the rule forbids.** A
 * negative assertion then fails on the explanation of the thing it is checking, and a POSITIVE one
 * is satisfied by a doc comment sitting directly above the line that dropped the term — an
 * assertion worse than none, because it is green.
 *
 * So every such test strips comments first. What went wrong is that the strippers were COPIED, and
 * the copies were not equally strong: `sessionsPage.lint.test.ts` dropped only lines whose trim
 * STARTS with `//`, so a **trailing** comment after real code survived it whole. A reviewer planted
 * the guard as `const x = y // const editorEnabled = ctx.editorEnabled === true && !isCentral`, the
 * needle test passed, and only a sibling assertion caught it. Two strippers of different strength
 * for one job is one stripper and one hole; this module is the strength, and there is no second one.
 *
 * **STATED LIMITS.** It is a regex, not a parser:
 *
 *  - `//` preceded by `:` is LEFT ALONE, so `https://…` inside a string survives. The cost is that a
 *    genuine comment written directly after a colon (`foo: // why`) is not stripped — which is the
 *    safe direction for a negative assertion and a rare shape in this codebase.
 *  - A `/* … *\/` or `//` sequence INSIDE a string literal is stripped like a comment, and on a big
 *    file that is not a rounding error. MEASURED on `App.tsx`: the string
 *    `'~/.claude/projects/**\/*.jsonl'` opens a "comment" that closes at the next real `*\/`
 *    **28.875 characters later**, taking `const appCtx` and the whole context literal with it — so a
 *    whole-file strip of that file silently deletes the very thing an assertion is about. CUT THE
 *    REGION OUT OF THE RAW SOURCE FIRST and strip that (`editorGate.test.ts`'s `appCtx`,
 *    `ArtifactsAside.gate.lint.test.ts`'s `tabsArray`), and give every scan a self-check that plants
 *    the defect: a needle that cannot be found in a file it was deleted from is not evidence.
 *  - Offsets do NOT survive: comments are removed, not blanked. A test that reports a LINE NUMBER
 *    needs a length-preserving stripper of its own (`touchTarget.lint.test.ts` has one, and says so).
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
