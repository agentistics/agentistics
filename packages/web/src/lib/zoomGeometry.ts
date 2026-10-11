/**
 * zoomGeometry.ts — makes the DOM's geometry answer in CSS px while `<html>` carries a CSS `zoom`.
 *
 * The text-size setting scales the whole UI with `zoom` on the document element (`textScale.ts`).
 * Under standardized CSS zoom — measured identically in Chromium 151, Firefox 153 and WebKit 26 —
 * the DOM answers in TWO coordinate spaces at once:
 *   - LOCAL CSS px (what a style write means): `offsetWidth`, an element's `clientWidth`,
 *     `scrollTop`, ResizeObserver;
 *   - VISUAL px (zoom already applied): `getBoundingClientRect`, a pointer's `clientX`,
 *     `innerWidth`, `visualViewport`, window scroll, `documentElement.clientWidth`.
 * Code that reads a rect and writes it into a style — every popover, menu, drag and tooltip in this
 * app, plus xterm's mouse mapping — then applies the zoom a SECOND time: at 1.5 a menu anchored at
 * a button's `rect.bottom` = 180 lands at 270. Fixing that per call site is ~300 sites today and
 * every popover written tomorrow.
 *
 * So this module does what the browser's own page zoom does: every API in the second list is made
 * to report CSS px (÷ zoom), and the `*FromPoint` / `scrollTo` inputs are scaled back (× zoom). The
 * two spaces agree again, a style written from a measurement lands where it was measured, and
 * `devicePixelRatio` grows by the zoom so a canvas keeps a sharp backing store — again what page
 * zoom does. Media queries are NOT touched: mobile vs desktop stays a fact about the DEVICE.
 *
 * It installs once, lazily, the first time the zoom leaves 1, and at a factor of 1 every patched
 * getter returns exactly what the native one did.
 */

let factor = 1
let installed = false

/** The zoom currently applied to `<html>` — 1 when the text size is the default. */
export function geometryZoom(): number { return factor }

/** The viewport's width in DEVICE-independent screen px — what the browser would report with no
 *  zoom applied — whatever the current zoom is. */
export function nativeViewportWidth(): number {
  return typeof window === 'undefined' ? 0 : (installed ? window.innerWidth * factor : window.innerWidth)
}

export function setGeometryZoom(zoom: number): void {
  factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  // Only a real DOM is patched — tests run with a bare `window` stub and no Element/Range at all.
  if (factor !== 1 && typeof window !== 'undefined' && typeof Element !== 'undefined' && typeof Range !== 'undefined') installZoomGeometry()
}

const div = (v: number) => (factor === 1 ? v : v / factor)
const mul = (v: number) => (factor === 1 ? v : v * factor)

type Getter = (this: unknown) => number

function wrapGetter(target: object | undefined | null, key: string, map: (v: number, self: unknown) => number): void {
  if (!target) return
  const d = Object.getOwnPropertyDescriptor(target, key)
  if (!d?.get || !d.configurable) return
  const get = d.get as Getter
  Object.defineProperty(target, key, { ...d, get(this: unknown) { return map(get.call(this), this) } })
}

function scaledRect(r: DOMRectReadOnly): DOMRect {
  return factor === 1 ? (r as DOMRect) : new DOMRect(r.x / factor, r.y / factor, r.width / factor, r.height / factor)
}

function scaledRectList(list: DOMRectList): DOMRectList {
  if (factor === 1) return list
  const out = Array.from(list, scaledRect) as unknown as DOMRect[] & { item(i: number): DOMRect | null }
  out.item = (i: number) => out[i] ?? null
  return out as unknown as DOMRectList
}

function isRootScroller(self: unknown): boolean {
  return self === document.documentElement || self === document.scrollingElement
}

/** The window's own attributes live on the instance in some engines and on the prototype in others. */
function windowHost(key: string): object | null {
  if (Object.getOwnPropertyDescriptor(window, key)) return window
  let proto = Object.getPrototypeOf(window)
  while (proto) {
    if (Object.getOwnPropertyDescriptor(proto, key)) return proto
    proto = Object.getPrototypeOf(proto)
  }
  return null
}

function installZoomGeometry(): void {
  if (installed) return
  installed = true

  // Rects — elements and ranges (a caret's rect anchors the mention popovers).
  for (const proto of [Element.prototype, Range.prototype]) {
    const rect = proto.getBoundingClientRect
    const rects = proto.getClientRects
    proto.getBoundingClientRect = function (this: Element & Range) { return scaledRect(rect.call(this)) }
    proto.getClientRects = function (this: Element & Range) { return scaledRectList(rects.call(this)) }
  }

  // Pointer coordinates.
  for (const key of ['clientX', 'clientY', 'pageX', 'pageY', 'x', 'y', 'offsetX', 'offsetY', 'movementX', 'movementY']) {
    wrapGetter(MouseEvent.prototype, key, div)
  }
  if (typeof Touch !== 'undefined') {
    for (const key of ['clientX', 'clientY', 'pageX', 'pageY']) wrapGetter(Touch.prototype, key, div)
  }

  // The viewport.
  for (const key of ['innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'pageXOffset', 'pageYOffset']) {
    wrapGetter(windowHost(key), key, div)
  }
  wrapGetter(windowHost('devicePixelRatio'), 'devicePixelRatio', mul)
  if (typeof VisualViewport !== 'undefined') {
    for (const key of ['width', 'height', 'offsetLeft', 'offsetTop', 'pageLeft', 'pageTop']) {
      wrapGetter(VisualViewport.prototype, key, div)
    }
  }

  // The root scroller is the one element whose own metrics are in the viewport's (visual) space.
  for (const key of ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight']) {
    wrapGetter(Element.prototype, key, (v, self) => (isRootScroller(self) ? div(v) : v))
  }
  for (const key of ['scrollTop', 'scrollLeft']) {
    const d = Object.getOwnPropertyDescriptor(Element.prototype, key)
    if (!d?.get || !d.set) continue
    const { get, set } = d
    Object.defineProperty(Element.prototype, key, {
      ...d,
      get(this: Element) { const v = get.call(this) as number; return isRootScroller(this) ? div(v) : v },
      set(this: Element, v: number) { set.call(this, isRootScroller(this) ? mul(v) : v) },
    })
  }
  for (const key of ['scrollTo', 'scroll', 'scrollBy'] as const) {
    const native = window[key].bind(window) as (...a: unknown[]) => void
    window[key] = ((a?: unknown, b?: unknown) => {
      if (typeof a === 'number') return native(mul(a), mul(Number(b ?? 0)))
      if (a && typeof a === 'object') {
        const o = { ...(a as ScrollToOptions) }
        if (typeof o.top === 'number') o.top = mul(o.top)
        if (typeof o.left === 'number') o.left = mul(o.left)
        return native(o)
      }
      return native(a, b)
    }) as typeof window.scrollTo
  }

  // Hit testing takes viewport coordinates as INPUT.
  const doc = Document.prototype as unknown as Record<string, unknown>
  for (const key of ['elementFromPoint', 'elementsFromPoint', 'caretRangeFromPoint', 'caretPositionFromPoint']) {
    const native = doc[key]
    if (typeof native !== 'function') continue
    doc[key] = function (this: Document, x: number, y: number, ...rest: unknown[]) {
      return (native as (...a: unknown[]) => unknown).call(this, mul(x), mul(y), ...rest)
    }
  }
}
