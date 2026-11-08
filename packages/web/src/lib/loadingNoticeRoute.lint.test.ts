import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// G (owner, 2026-11-06): the "still loading / figures may be incomplete" notices
// (`loading.startup`, `loading.journal`) are never raised on the Sessions page. The guard is one
// line at the top of the effect that pushes them, so this reads the source, the way the repo's other
// lint tests do, to keep a refactor from dropping it.
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

test('the loading notices are not pushed while the Sessions workspace is open', () => {
  const effect = app.slice(app.indexOf('const loadingNoticeSeen'))
  const body = effect.slice(0, effect.indexOf('}, [startup, teamSession?.journalBackfill'))
  expect(body).toContain('if (inSessionsWorkspace) return')
  // The guard comes BEFORE either notice is built or pushed.
  expect(body.indexOf('if (inSessionsWorkspace) return')).toBeLessThan(body.indexOf('startupLoadingNotification('))
  expect(body.indexOf('if (inSessionsWorkspace) return')).toBeLessThan(body.indexOf('pushNotification('))
  // ...and the effect re-runs when the person leaves the Sessions page.
  expect(effect).toContain('lang, inSessionsWorkspace])')
})
