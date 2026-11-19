import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (p: string) => readFileSync(join(import.meta.dir, '..', '..', p), 'utf8')

// The list menu opened from the Nay drawer lives on EVERY route, so the host must too.
test('the held-kill host is mounted once, in the app shell, and not in the sessions page', () => {
  expect(src('App.tsx')).toMatch(/<HeldKillHost[\s\S]*?\/>/)
  expect(src('pages/SessionsPage.tsx')).not.toContain('<HeldKillHost')
})

test('the list menu falls back to its notice when the offer is refused', () => {
  expect(src('components/nav/SessionsAside.tsx')).toMatch(/held === true && offerHeldKill\(/)
})
