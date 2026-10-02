import { describe, expect, test, beforeEach } from 'bun:test'
import type { CardPlacement, NayAnimation } from './nayNotify'
import { playEnter } from './nayNotifyAnim'

/** A just-enough DOM: elements that nest, remove themselves, and animate on command. */
class FakeAnim {
  cancelled = false
  private res!: () => void
  finished = new Promise<void>((r, j) => { this.res = r; this.rej = j })
  rej!: (e?: unknown) => void
  cancel() { if (this.cancelled) return; this.cancelled = true; this.rej() }
  finish() { this.res() }
}
class FakeEl {
  style: Record<string, string> = {}
  children: FakeEl[] = []
  parent: FakeEl | null = null
  private _id = ''
  get id() { return this._id }
  set id(v: string) { this._id = v; if (v === 'ag-nay-fx') layer = this }
  anims: FakeAnim[] = []
  constructor(public tag = 'div') {}
  setAttribute() {}
  appendChild(c: FakeEl) { c.parent = this; this.children.push(c); return c }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null }
  animate() { const a = new FakeAnim(); this.anims.push(a); return a as unknown as Animation }
  getBoundingClientRect() { return { left: 100, top: 100, width: 300, height: 200, right: 400, bottom: 300 } }
  querySelectorAll(sel: string) { return this.all().filter(e => sel === 'path' ? e.tag === 'path' : false) }
  querySelector() { return null }
  private all(): FakeEl[] { return this.children.flatMap(c => [c, ...c.all()]) }
}
let layer: FakeEl | null = null
const body = new FakeEl('body')
const g = globalThis as unknown as Record<string, unknown>
g.document = {
  body,
  getElementById: (id: string) => (layer && id === 'ag-nay-fx' ? layer : null),
  createElement: () => new FakeEl(),
  createElementNS: (_: string, tag: string) => { const e = new FakeEl(tag); return Object.assign(e, { setAttribute() {} }) },
}
g.window = { innerWidth: 1000, innerHeight: 800, setTimeout, clearTimeout }

const P: CardPlacement = { left: 0, top: 0, originX: 50, originY: 20, tail: true, tailSide: 'top', tailX: 40 } as CardPlacement
const KINDS: NayAnimation[] = ['unfurl', 'voice', 'launch', 'balloon']
const fxCount = () => (layer ? layer.children.length : 0)
const mk = () => [new FakeEl() as unknown as HTMLElement, new FakeEl() as unknown as HTMLElement] as const

beforeEach(() => { layer = null; body.children = [] })

describe('playEnter leaves nothing in the fx layer', () => {
  for (const kind of KINDS) {
    test(`${kind}: cancel at any moment empties the layer`, () => {
      const [card, fab] = mk()
      const cancel = playEnter(kind, card, fab, P, false)
      if (kind === 'unfurl' || kind === 'voice' || kind === 'launch') expect(fxCount()).toBeGreaterThan(0)
      cancel()
      expect(fxCount()).toBe(0)
      cancel() // idempotent
      expect(fxCount()).toBe(0)
    })
    test(`${kind}: a drag (dropFx) mid-entrance leaves nothing, the card's own animation goes on`, () => {
      const [card, fab] = mk()
      const h = playEnter(kind, card, fab, P, false)
      h.dropFx()
      expect(fxCount()).toBe(0)
      expect((card as unknown as FakeEl).anims.every(a => !a.cancelled)).toBe(true)
      h()
      expect(fxCount()).toBe(0)
    })
  }
  test('unfurl: cancelled after the grow ended, mid-fade, still clean', async () => {
    const [card, fab] = mk()
    const cancel = playEnter('unfurl', card, fab, P, false)
    const m = layer!.children[0]!
    m.anims[0]!.finish()
    await Promise.resolve(); await Promise.resolve()
    cancel()
    expect(fxCount()).toBe(0)
  })
  test('reduced motion: no effects at all, cancel is safe', () => {
    const [card, fab] = mk()
    const cancel = playEnter('unfurl', card, fab, P, true)
    expect(fxCount()).toBe(0)
    cancel()
    expect(fxCount()).toBe(0)
  })
  test('no button on screen: nothing to leave behind', () => {
    const [card] = mk()
    const cancel = playEnter('launch', card, null, P, false)
    cancel()
    expect(fxCount()).toBe(0)
  })
})
