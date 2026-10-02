import { afterEach, expect, test } from 'bun:test'
import { createScene, type SceneVariant } from './updateScene'

/** A recording 2D context: every method is a counter, every property assignable, gradients inert. */
function fakeCtx() {
  const calls: Record<string, number> = {}
  const grad = { addColorStop() {} }
  const ctx: any = new Proxy({}, {
    get: (t: any, k: string) => k in t ? t[k] : k.startsWith('create') ? () => grad : (...a: unknown[]) => { calls[k] = (calls[k] ?? 0) + 1 },
    set: (t: any, k: string, v) => { t[k] = v; return true },
  })
  return { ctx, calls }
}

const g: any = globalThis
const saved = { window: g.window, Path2D: g.Path2D, document: g.document }
// The stubs must not outlive the test: other suites decide "is there a DOM" by looking at these.
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v } })

function setup() {
  const main = fakeCtx()
  g.window = { devicePixelRatio: 2, innerWidth: 1000, innerHeight: 700 }
  g.Path2D = class { moveTo() {} lineTo() {} closePath() {} rect() {} }
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx().ctx }) }
  const canvas: any = { width: 0, height: 0, clientWidth: 1000, clientHeight: 700, getContext: () => main.ctx, getBoundingClientRect: () => ({ left: 0, top: 0 }) }
  const logo: any = { complete: true, naturalWidth: 10 }
  return { canvas, logo, calls: main.calls }
}

for (const variant of ['core', 'hive'] as SceneVariant[]) {
  test(`${variant}: renders the loader and the finale, and draws the logo square`, () => {
    const { canvas, logo, calls } = setup()
    const scene = createScene(canvas, variant, logo, false)
    scene.resize()
    for (let i = 0; i < 20; i++) scene.drawRunning({ p: i / 20, indet: i > 14, now: i * 16, dt: 16 })
    expect(calls.drawImage).toBeGreaterThan(20) // background layer (+ logo) every frame
    for (let t = 0; t < 4; t += 0.05) scene.drawFinale({ t, now: t * 1000, dt: 50 })
    expect(calls.stroke).toBeGreaterThan(0)
    scene.dispose()
  })
  test(`${variant}: reduced motion draws without throwing`, () => {
    const { canvas, logo } = setup()
    const scene = createScene(canvas, variant, logo, true)
    scene.resize()
    scene.drawRunning({ p: 0.5, indet: false, now: 0, dt: 16 })
    scene.drawFinale({ t: 0, now: 0, dt: 16 })
  })
}

const rect = (l: number, t: number, w: number, h: number) => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h })

test('no scene has a scrim any more: the hive makes room instead (setInk), the core ignores it', () => {
  for (const variant of ['core', 'hive'] as SceneVariant[]) {
    const { canvas, logo } = setup()
    const scene: any = createScene(canvas, variant, logo, false)
    expect(scene.setScrim).toBeUndefined()
    expect(typeof scene.setInk).toBe('function')
  }
})

test('hive: given the text lines it draws, never throws, and re-measures them as they change', () => {
  const { canvas, logo, calls } = setup()
  let measured = 0
  const el = (r: ReturnType<typeof rect>) => ({ getBoundingClientRect: () => { measured++; return r } }) as unknown as HTMLElement
  const scene = createScene(canvas, 'hive', logo, false)
  scene.resize()
  scene.setInk([el(rect(400, 60, 200, 20)), el(rect(380, 560, 240, 20)), null, el(rect(250, 620, 500, 16))])
  for (let i = 0; i < 60; i++) scene.drawRunning({ p: 0.3 + i / 100, indet: i > 40, now: i * 16, dt: 16 })
  expect(measured).toBeGreaterThan(3)          // measured at least once, and again after 500 ms
  expect(calls.drawImage).toBeGreaterThan(60)  // background + the sprite blits
  scene.dispose()
})

test('hive: a resize to the same size keeps the standing hive; a new size rebuilds it', () => {
  const { canvas, logo } = setup()
  const scene = createScene(canvas, 'hive', logo, false)
  scene.resize(); scene.drawRunning({ p: 0.5, indet: false, now: 0, dt: 16 })
  scene.resize()
  scene.drawRunning({ p: 0.5, indet: false, now: 16, dt: 16 })
  canvas.clientWidth = 390; canvas.clientHeight = 844
  scene.resize()
  scene.drawRunning({ p: 0.5, indet: false, now: 32, dt: 16 })
})
