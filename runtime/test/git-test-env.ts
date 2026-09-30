/**
 * git-test-env.ts — the environment every runtime TEST that runs `git` itself must use.
 *
 * The canonical implementation now lives in `@agentistics/core/gitTestEnv` (see that module's
 * header for the incident this exists to prevent, and the full, cited variable list) — this file
 * is a thin re-export so every existing import site in this package (`../../../test/git-test-env.ts`)
 * keeps working unchanged. It lives outside `src/` on purpose, same as before: `provider-secrets
 * .lint.test.ts` forbids reading the process environment anywhere in `src/`, and while this file no
 * longer reads it directly, `runtime-boundary.lint.test.ts` (D23) still walks it as part of the
 * package, and re-exporting `@agentistics/core` (a bare specifier, not a relative escape) is exactly
 * the case that lint allows: the runtime already depends on `@agentistics/core` as a real workspace
 * package, so there is no reason to hold a second implementation here.
 *
 * `packages/server`'s tests import the same canonical function directly from
 * `@agentistics/core/gitTestEnv` — this re-export exists for the runtime's OWN existing import
 * sites, not as a second canonical copy.
 */
export { gitTestEnv } from '@agentistics/core/gitTestEnv'
