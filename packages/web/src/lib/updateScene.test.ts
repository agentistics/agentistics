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
  g.Path2D = class { moveTo() {} lineTo() {} closePath() {} }
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx().ctx }) }
  const canvas: any = { width: 0, height: 0, clientWidth: 1000, clientHeight: 700, getContext: () => main.ctx }
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
