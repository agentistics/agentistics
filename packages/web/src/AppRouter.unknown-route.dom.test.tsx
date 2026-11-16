import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

// An address no route names used to leave the boot screen up forever ("No routes matched location").
// The layout, the loader and the two pages that matter are stand-ins: what is under test is the ROUTE TABLE.
// `mock.module` is process-global in bun, so the real modules are captured first and put back in afterAll.
const MOCKED = ['./App', './components/CenteredLoader', './pages/HomePage', './pages/TasksPage'] as const
const real = Object.fromEntries(await Promise.all(MOCKED.map(async m => [m, { ...(await import(m)) }])))
mock.module('./App', () => ({
  default: () => {
    const { Outlet } = require('react-router-dom')
    return <Outlet />
  },
}))
// The real loader animates through the Web Animations API, which happy-dom rejects on unmount.
mock.module('./components/CenteredLoader', () => ({ CenteredLoader: () => <div data-testid="loader">loading</div> }))
mock.module('./pages/HomePage', () => ({ default: () => <div data-testid="home">home</div> }))
mock.module('./pages/TasksPage', () => ({ default: () => <div data-testid="tasks">tasks</div> }))

let createRoot: typeof import('react-dom/client').createRoot
let AppRouter: typeof import('./AppRouter').default
let oldAct: boolean | undefined
beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900, url: 'http://localhost/' })
  oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  AppRouter = (await import('./AppRouter')).default
})
afterAll(async () => {
  for (const m of MOCKED) mock.module(m, () => real[m])
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct; await GlobalRegistrator.unregister() })

async function visit(path: string) {
  window.history.pushState({}, '', path)
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<AppRouter />) })
  for (let i = 0; i < 40 && !host.querySelector('[data-testid="home"],[data-testid="tasks"]'); i++) await act(async () => { await new Promise(r => setTimeout(r, 25)) })
  const out = { path: window.location.pathname, home: !!host.querySelector('[data-testid="home"]'), tasks: !!host.querySelector('[data-testid="tasks"]') }
  await act(async () => { root.unmount(); host.remove() })
  return out
}

test('an unknown address renders the home page instead of hanging', async () => {
  expect(await visit('/nao-existe')).toEqual({ path: '/', home: true, tasks: false })
})

test('/live goes to the Live Delivery board', async () => {
  expect(await visit('/live')).toEqual({ path: '/tasks/live', home: false, tasks: true })
})
