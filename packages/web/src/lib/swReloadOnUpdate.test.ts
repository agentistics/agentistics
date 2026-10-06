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

  test('it claims a replacement but leaves navigation to the page update flow', () => {
    expect(script).toContain("self.addEventListener('install'")
    expect(script).toContain('self.registration.active')
    expect(script).toContain("self.addEventListener('activate'")
    expect(script).toContain('if (!replacedAnotherWorker) return')
    expect(script).not.toContain('w.navigate(')
    // The worker must claim, but must not navigate behind the overlay.
    expect(script.indexOf('clients.claim()')).toBeGreaterThan(-1)
  })

  test('it can run as a worker script: it parses and registers exactly the two listeners', () => {
    const listeners: string[] = []
    const registration = { active: {} }
    const run = new Function('self', script)
    run({ addEventListener: (t: string) => { listeners.push(t) }, registration, clients: { matchAll: async () => [] } })
    expect(listeners).toEqual(['install', 'activate'])
  })
})
