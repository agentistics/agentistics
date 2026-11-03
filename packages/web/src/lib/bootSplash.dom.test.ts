import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// The splash line ("agentistics just restarted … almost there") is written by the loading screen and
// must go with it: once the server answers and the route is restored, no boot text may remain.
let setBootStatus: typeof import('./bootSplash').setBootStatus
let releaseBoot: typeof import('./bootSplash').releaseBoot
beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 844 })
  ;({ setBootStatus, releaseBoot } = await import('./bootSplash'))
})
afterAll(async () => { await GlobalRegistrator.unregister() })

const splash = () => document.querySelector<HTMLElement>('#ag-preboot .ag-boot-status')!

test('the boot line is written, left alone by null, and cleared by an empty string', () => {
  document.body.innerHTML = '<div id="ag-preboot"><p class="ag-boot-status"></p></div>'
  setBootStatus('agentistics just restarted on the new version and is reading your history — almost there.')
  expect(splash().textContent).toContain('almost there')
  setBootStatus(null)
  expect(splash().textContent).toContain('almost there')
  setBootStatus('')
  expect(splash().textContent).toBe('')
})

test('server back → the splash leaves with its text and the route is untouched', () => {
  document.body.innerHTML = '<div id="ag-preboot"><p class="ag-boot-status">almost there</p></div>'
  ;(window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('http://localhost/repositories')
  setBootStatus('')
  releaseBoot()
  expect(document.body.textContent).not.toContain('almost there')
  expect(window.location.pathname).toBe('/repositories')
})
