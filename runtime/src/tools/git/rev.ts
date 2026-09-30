/**
 * tools/git/rev.ts — PURE. Whether a `rev` the model supplied is safe to hand to `git diff` /
 * `git log` as a bare positional argument (spec docs/superpowers/specs/
 * 2026-09-20-runtime-b3-tool-catalogue.md §3, D-T6 "option-injection" acceptance test).
 *
 * A revision argument sits BEFORE `--` in both commands' syntax, so unlike a path (always passed
 * after `--`, where git treats everything literally regardless of a leading `-`) a `rev` value
 * git has not yet been told to stop parsing as an option. `--rev="--upload-pack=..."` or
 * `rev: '-O/etc/passwd'` would otherwise be read as a FLAG, not a revision.
 *
 * This is an ALLOWLIST, not a blocklist: a blocklist only refuses the option-shapes it was written
 * to recognise, and git's option grammar keeps growing. `isSafeRev` instead recognises the shape a
 * real git revision (a branch, tag, SHA, `HEAD~2`, `origin/main`, `refs/heads/x`, `v1.2.3^{}`,
 * `@{upstream}`, …) actually takes and refuses everything else — including, structurally, anything
 * starting with `-` (the pattern requires an alphanumeric first character) and anything containing
 * whitespace (not in the allowed character set).
 *
 * `spawn.ts`'s `--end-of-options` is the SECOND line of defense for the same input: even a rev
 * that somehow got past this check (a caller that skipped `parse()` entirely, say) is still read
 * as a plain argument once `--end-of-options` has been seen, never as a flag.
 */

// The first character is alphanumeric OR `@` (git's own shorthand for HEAD, and the lead-in for
// `@{upstream}` / `@{-1}` / `@{push}`) — never `-`, which is what keeps this an allowlist a leading
// option flag cannot pass.
const REV_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9._/@{}^~:-]*$/

const REV_MAX_LENGTH = 256

export function isSafeRev(rev: string): boolean {
  if (rev.length === 0 || rev.length > REV_MAX_LENGTH) return false
  if (/\s/.test(rev)) return false
  if (rev.startsWith('-')) return false
  return REV_PATTERN.test(rev)
}
