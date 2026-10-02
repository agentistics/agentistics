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
  const layers: ReturnType<typeof fakeCtx>[] = []
  g.window = { devicePixelRatio: 2, innerWidth: 1000, innerHeight: 700 }
  g.Path2D = class { moveTo() {} lineTo() {} closePath() {} rect() {} }
  g.document = { createElement: () => { const c = fakeCtx(); layers.push(c); return { width: 0, height: 0, getContext: () => c.ctx } } }
  const canvas: any = { width: 0, height: 0, clientWidth: 1000, clientHeight: 700, getContext: () => main.ctx, getBoundingClientRect: () => ({ left: 0, top: 0 }) }
  const logo: any = { complete: true, naturalWidth: 10 }
  return { canvas, logo, calls: main.calls, layers }
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
  g.window.innerWidth = 390; g.window.innerHeight = 844 // the hive's cell canvas fills the stage: its size is the viewport
  scene.resize()
  scene.drawRunning({ p: 0.5, indet: false, now: 32, dt: 16 })
})

test('hive: the cell field is its own canvas beneath the one handed in (the handed-in one is the small fx layer)', () => {
  const { canvas, logo } = setup()
  const inserted: unknown[] = []
  canvas.parentNode = { insertBefore: (n: unknown, ref: unknown) => { inserted.push([n, ref]) } }
  const scene = createScene(canvas, 'hive', logo, false)
  expect(inserted).toHaveLength(1)
  expect((inserted[0] as unknown[])[1]).toBe(canvas)
  scene.resize()
  scene.drawRunning({ p: 0.5, indet: false, now: 0, dt: 16 })
  // running: fx is only the frame + glow (a few hundred px), not the stage; the finale takes the whole stage
  canvas.style = {}
  scene.resize(); canvas.style = {}
  g.window.innerWidth = 1001
  scene.resize()
  scene.drawRunning({ p: 0.5, indet: false, now: 16, dt: 16 })
  expect(canvas.width).toBeLessThan(1001 * 1.5)
  expect(canvas.width).toBeGreaterThan(0)
  scene.drawFinale({ t: 0.2, now: 32, dt: 16 })
  expect(canvas.width).toBeGreaterThanOrEqual(1001 * 1.5 - 2)
  scene.dispose()
})

test('hive: settled cells are redrawn at ~30 Hz, not every frame; any motion brings the full rate back', () => {
  const { canvas, logo, layers } = setup()
  const scene = createScene(canvas, 'hive', logo, false)
  scene.resize()
  const cell = layers[0]!  // the first canvas the hive creates is the cell field
  let now = 0
  const frame = (p: number) => { now += 16; scene.drawRunning({ p, indet: false, now, dt: 16 }) }
  for (let i = 0; i < 400; i++) frame(0.4)                      // build the field, let it settle
  const settled0 = cell.calls.clearRect ?? 0
  for (let i = 0; i < 120; i++) frame(0.4)
  const settled = (cell.calls.clearRect ?? 0) - settled0
  expect(settled).toBeGreaterThan(120 * 0.25)                   // it does redraw (the twinkle)…
  expect(settled).toBeLessThan(120 * 0.7)                       // …at about half the frame rate
  const moving0 = cell.calls.clearRect ?? 0
  for (let i = 0; i < 40; i++) frame(0.4 + (i + 1) * 0.01)      // progress moves: cells enter
  expect((cell.calls.clearRect ?? 0) - moving0).toBeGreaterThanOrEqual(38) // every frame again
})
