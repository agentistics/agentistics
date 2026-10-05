import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(import.meta.dir, '..', '..')
const script = readFileSync(join(WEB, 'public', 'sw-reload-on-update.js'), 'utf8')
const config = readFileSync(join(WEB, 'vite.config.ts'), 'utf8')

describe('the service worker reloads open windows when it replaces an older worker', () => {
  test('the worker pulls the script in, and still skips waiting and claims clients', () => {
    expect(config).toContain("importScripts: ['sw-reload-on-update.js']")
    expect(config).toContain('skipWaiting: true')
    expect(config).toContain('clientsClaim: true')
  })

  test('it reloads only when another worker was active at install (a first install reloads nothing)', () => {
    expect(script).toContain("self.addEventListener('install'")
    expect(script).toContain('self.registration.active')
    expect(script).toContain("self.addEventListener('activate'")
    expect(script).toContain('if (!replacedAnotherWorker) return')
    expect(script).toContain('w.navigate(')
    // navigate() only works on a controlled window: the worker must claim BEFORE it navigates.
    expect(script.indexOf('clients.claim()')).toBeGreaterThan(-1)
    expect(script.indexOf('clients.claim()')).toBeLessThan(script.indexOf('w.navigate('))
    // ...and it must not AWAIT the navigation inside waitUntil (the navigation's fetch waits for activation).
    expect(script).not.toMatch(/Promise\.all\([^)]*navigate/)
    expect(script).toContain('for (const w of windows) w.navigate(w.url).catch(() => {})')
  })

  test('it can run as a worker script: it parses and registers exactly the two listeners', () => {
    const listeners: string[] = []
    const registration = { active: {} }
    const run = new Function('self', script)
    run({ addEventListener: (t: string) => { listeners.push(t) }, registration, clients: { matchAll: async () => [] } })
    expect(listeners).toEqual(['install', 'activate'])
  })
})
