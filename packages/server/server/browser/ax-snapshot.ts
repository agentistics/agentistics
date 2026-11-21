/**
 * ax-snapshot.ts — PURE: the accessibility tree CDP returns (`Accessibility.getFullAXTree`) as the text a
 * model reads, with a REF on every element it can act on (NAVEGADOR S2, spec §1.1 / §5).
 *
 * The rules, each one measured or a thing QA will try to break:
 *
 * - **A ref IS the node's `backendDOMNodeId`** (`e<id>`). It is stable for as long as the node lives —
 *   within one snapshot by construction, and across snapshots while the page keeps the node — and a
 *   click/type resolves it with no table on the server (probe P3: `DOM.getBoxModel(backendNodeId)` +
 *   `Input.dispatchMouseEvent` works). A ref the page no longer has fails in CDP and is said in words.
 * - **There is a CEILING** (`maxBytes`, default `DEFAULT_SNAPSHOT_BYTES`): GitHub measured 49 KB
 *   (~12 k tokens) per call even with text nodes filtered (P3). Past the ceiling the text stops at a
 *   LINE boundary and ends with one sentence saying how many lines and refs were left out and how to
 *   see them (viewport mode after a scroll). Never a cut mid-line, never a silent cut.
 * - **Viewport mode** keeps only nodes whose layout box meets the visible rectangle (or that contain
 *   one that does). The boxes come from `DOMSnapshot.captureSnapshot` and the rectangle from
 *   `Page.getLayoutMetrics`, both read by the caller; here they are plain numbers.
 * - **Text is filtered**: `InlineTextBox` always; `StaticText` when it only repeats the name of the
 *   element it sits in (a link "Home" holding the text "Home"). Text that says something new — a
 *   paragraph — is kept, because a page the model cannot read is a page it cannot test.
 * - **Structure without meaning is flattened**: ignored nodes and unnamed `generic`/`none` wrappers add
 *   no line and no indent; their children take their place.
 * - **The page chooses every string here**, so each one is cleaned (control and bidi-override
 *   characters removed, whitespace collapsed) and capped, then JSON-quoted: a name cannot forge a line,
 *   a ref or the truncation notice.
 */

export interface AXValue { type?: string; value?: unknown }
export interface AXProperty { name: string; value?: AXValue }
export interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: AXProperty[]
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
}

export interface Box { x: number; y: number; w: number; h: number }

export interface SnapshotOptions {
  /** Byte ceiling of the whole text (clamped to [MIN, MAX]). */
  maxBytes?: number
  /** Viewport mode: only nodes whose box meets `rect` (document CSS pixels), or that contain one. */
  viewport?: { rect: Box; boxes: ReadonlyMap<number, Box> } | null
  /** The snapshot generation every ref is bound to (`e12@g3`); absent = bare `e12`. */
  gen?: number
  /** Lines put first (URL, title) — counted against the ceiling. */
  header?: readonly string[]
}

export interface AxSnapshot {
  text: string
  /** ref → backendDOMNodeId, for every ref that made it into `text`. */
  refs: Record<string, number>
  truncated: boolean
  /** Lines the tree produced, and how many are in `text`. */
  totalLines: number
  shownLines: number
  /** Refs that were in the left-out lines. */
  omittedRefs: number
  bytes: number
}

export const DEFAULT_SNAPSHOT_BYTES = 20_000
export const MIN_SNAPSHOT_BYTES = 2_000
export const MAX_SNAPSHOT_BYTES = 60_000
const NAME_CAP = 160
const VALUE_CAP = 120

/** Roles a model acts on — each gets a ref. */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider',
  'spinbutton', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem',
  'textField', 'TextField', 'PopUpButton', 'ToggleButton', 'colorwell', 'scrollbar',
])

const TRANSPARENT_ROLES: ReadonlySet<string> = new Set(['generic', 'none', 'presentation', 'GenericContainer', 'Unknown', 'LineBreak', ''])
const VALUE_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'textField', 'TextField'])

/** Parse `e123` back to a backend node id; null for anything else. */
export function parseRef(ref: unknown): number | null {
  if (typeof ref !== 'string') return null
  const m = /^e([1-9]\d{0,9})$/.exec(ref)
  if (!m) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) ? n : null
}

/** `e123` (a bare id, as the pure snapshot tests build it) or `e123@g4` (bound to snapshot generation 4). */
export function refOf(backendId: number, gen?: number): string { return gen === undefined ? `e${backendId}` : `e${backendId}@g${gen}` }

/** Parse `e123@g4` into its node id and snapshot generation; `gen` is null for a bare `e123`. */
export function parseBoundRef(ref: unknown): { id: number; gen: number | null } | null {
  if (typeof ref !== 'string') return null
  const m = /^e([1-9]\d{0,9})(?:@g([1-9]\d{0,9}))?$/.exec(ref)
  if (!m) return null
  const id = Number(m[1]), gen = m[2] === undefined ? null : Number(m[2])
  return Number.isSafeInteger(id) && (gen === null || Number.isSafeInteger(gen)) ? { id, gen } : null
}

/** A page-chosen string, made safe to put on one line. */
export function cleanText(v: unknown, cap: number): string {
  if (v === undefined || v === null) return ''
  const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean
}

function prop(n: AXNode, name: string): unknown {
  return n.properties?.find(p => p.name === name)?.value?.value
}

function roleOf(n: AXNode): string { return typeof n.role?.value === 'string' ? n.role.value : '' }

function intersects(a: Box, b: Box): boolean {
  return a.w > 0 && a.h > 0 && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function clampBytes(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_SNAPSHOT_BYTES
  return Math.max(MIN_SNAPSHOT_BYTES, Math.min(MAX_SNAPSHOT_BYTES, Math.floor(n)))
}

interface Line { text: string; ref: string | null; backend: number | null }

/** The snapshot. Never throws on a malformed tree: unknown shapes are skipped. */
export function axSnapshot(nodes: readonly AXNode[], opts: SnapshotOptions = {}): AxSnapshot {
  const byId = new Map<string, AXNode>()
  for (const n of nodes) if (n && typeof n.nodeId === 'string') byId.set(n.nodeId, n)
  const root = nodes.find(n => n && !n.parentId && byId.has(n.nodeId)) ?? nodes[0]

  // Viewport: which subtrees hold something visible (post-order, iterative, cycle-safe).
  let visible: ((id: string) => boolean) | null = null
  if (opts.viewport) {
    const vp = opts.viewport
    const memo = new Map<string, boolean>()
    const compute = (start: string): boolean => {
      const stack: Array<{ id: string; done: boolean }> = [{ id: start, done: false }]
      const onStack = new Set<string>()
      while (stack.length) {
        const top = stack[stack.length - 1]!
        if (memo.has(top.id)) { stack.pop(); continue }
        const n = byId.get(top.id)
        if (!n) { memo.set(top.id, false); stack.pop(); continue }
        if (!top.done) {
          top.done = true
          onStack.add(top.id)
          for (const c of n.childIds ?? []) if (!memo.has(c) && !onStack.has(c)) stack.push({ id: c, done: false })
          continue
        }
        stack.pop()
        onStack.delete(top.id)
        const box = n.backendDOMNodeId !== undefined ? vp.boxes.get(n.backendDOMNodeId) : undefined
        let v = box ? intersects(box, vp.rect) : false
        if (!v) for (const c of n.childIds ?? []) if (memo.get(c)) { v = true; break }
        memo.set(top.id, v)
      }
      return memo.get(start) ?? false
    }
    visible = (id) => memo.has(id) ? memo.get(id)! : compute(id)
  }

  const lines: Line[] = []
  if (root) {
    // DFS in document order. `ctx` = the nearest emitted ancestor's name (for the text dedupe).
    const stack: Array<{ id: string; depth: number; parentName: string }> = [{ id: root.nodeId, depth: 0, parentName: '' }]
    const seen = new Set<string>()
    while (stack.length) {
      const { id, depth, parentName } = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const n = byId.get(id)
      if (!n) continue
      if (visible && !visible(id)) continue
      const role = roleOf(n)
      if (role === 'InlineTextBox') continue
      const name = cleanText(n.name?.value, NAME_CAP)
      let childDepth = depth
      let childParentName = parentName
      if (role === 'StaticText') {
        if (name && !parentName.includes(name)) lines.push({ text: `${'  '.repeat(depth)}- text ${JSON.stringify(name)}`, ref: null, backend: null })
        continue // a text node's children are its inline boxes
      }
      const focusable = prop(n, 'focusable') === true
      const interactive = INTERACTIVE_ROLES.has(role) || (focusable && !TRANSPARENT_ROLES.has(role) && role !== 'RootWebArea' && role !== 'WebArea')
      const transparent = n.ignored === true || role === 'RootWebArea' || role === 'WebArea'
        || (TRANSPARENT_ROLES.has(role) && !name && !interactive)
      if (!transparent) {
        const ref = interactive && typeof n.backendDOMNodeId === 'number' && n.backendDOMNodeId > 0 ? refOf(n.backendDOMNodeId, opts.gen) : null
        lines.push({ text: `${'  '.repeat(depth)}- ${describe(n, role, name)}${ref ? ` [ref=${ref}]` : ''}`, ref, backend: ref ? n.backendDOMNodeId! : null })
        childDepth = depth + 1
        childParentName = name
      }
      const kids = n.childIds ?? []
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i]!, depth: childDepth, parentName: childParentName })
    }
  }

  // The ceiling, at a line boundary, with the notice inside the budget.
  const max = clampBytes(opts.maxBytes)
  const header = (opts.header ?? []).map(h => cleanText(h, 300))
  const enc = (s: string) => Buffer.byteLength(s, 'utf8') + 1
  let used = header.reduce((a, h) => a + enc(h), 0)
  const NOTICE_RESERVE = 260
  const out: string[] = [...header]
  const refs: Record<string, number> = {}
  let shown = 0
  // Everything fits: no notice, the whole ceiling is usable. Otherwise leave room for the notice.
  const whole = used + lines.reduce((a, l) => a + enc(l.text), 0)
  const budget = whole <= max ? max : max - NOTICE_RESERVE
  for (const l of lines) {
    const cost = enc(l.text)
    if (used + cost > budget) break
    out.push(l.text)
    used += cost
    shown++
    if (l.ref) refs[l.ref] = l.backend!
  }
  const truncated = shown < lines.length
  let omittedRefs = 0
  if (truncated) {
    for (let i = shown; i < lines.length; i++) if (lines[i]!.ref) omittedRefs++
    out.push(`[truncated: ${lines.length - shown} more line(s) and ${omittedRefs} more ref(s) not shown (limit ${max} bytes). Use mode "viewport" — after agentistics_browser_scroll for the rest of the page — or a larger maxBytes (up to ${MAX_SNAPSHOT_BYTES}).]`)
  }
  if (lines.length === 0) out.push('(the page exposes nothing readable here)')
  const text = out.join('\n')
  return { text, refs, truncated, totalLines: lines.length, shownLines: shown, omittedRefs, bytes: Buffer.byteLength(text, 'utf8') }
}

function describe(n: AXNode, role: string, name: string): string {
  const parts: string[] = [role || 'node']
  if (name) parts.push(JSON.stringify(name))
  const attrs: string[] = []
  const level = prop(n, 'level')
  if (typeof level === 'number') attrs.push(`level=${level}`)
  for (const k of ['checked', 'pressed', 'selected', 'expanded']) {
    const v = prop(n, k)
    if (v === true || v === 'true') attrs.push(k)
    else if (v === 'mixed') attrs.push(`${k}=mixed`)
  }
  if (prop(n, 'disabled') === true) attrs.push('disabled')
  if (prop(n, 'required') === true) attrs.push('required')
  if (prop(n, 'focused') === true) attrs.push('focused')
  if (attrs.length) parts.push(`[${attrs.join(' ')}]`)
  if (VALUE_ROLES.has(role)) {
    const v = cleanText(n.value?.value, VALUE_CAP)
    if (v) parts.push(`value=${JSON.stringify(v)}`)
  }
  return parts.join(' ')
}

/**
 * Layout boxes out of `DOMSnapshot.captureSnapshot` (main document only): backend node id → box in
 * document CSS pixels. Tolerant of a missing field (an empty map, never a throw).
 */
export function boxesFromDomSnapshot(snap: unknown): Map<number, Box> {
  const out = new Map<number, Box>()
  const doc = (snap as any)?.documents?.[0]
  const backend: unknown = doc?.nodes?.backendNodeId
  const nodeIndex: unknown = doc?.layout?.nodeIndex
  const bounds: unknown = doc?.layout?.bounds
  if (!Array.isArray(backend) || !Array.isArray(nodeIndex) || !Array.isArray(bounds)) return out
  for (let i = 0; i < nodeIndex.length; i++) {
    const ni = nodeIndex[i]
    const b = bounds[i]
    const id = typeof ni === 'number' ? backend[ni] : undefined
    if (typeof id !== 'number' || !Array.isArray(b) || b.length < 4) continue
    const [x, y, w, h] = b as number[]
    if (![x, y, w, h].every(Number.isFinite)) continue
    const prev = out.get(id)
    // A node can own several layout objects (inline fragments): keep their union.
    if (prev) {
      const x0 = Math.min(prev.x, x!), y0 = Math.min(prev.y, y!)
      out.set(id, { x: x0, y: y0, w: Math.max(prev.x + prev.w, x! + w!) - x0, h: Math.max(prev.y + prev.h, y! + h!) - y0 })
    } else out.set(id, { x: x!, y: y!, w: w!, h: h! })
  }
  return out
}

/** The visible rectangle out of `Page.getLayoutMetrics` (`cssVisualViewport`), or null. */
export function viewportRect(metrics: unknown): Box | null {
  const v = (metrics as any)?.cssVisualViewport ?? (metrics as any)?.visualViewport
  if (!v) return null
  const r = { x: Number(v.pageX), y: Number(v.pageY), w: Number(v.clientWidth), h: Number(v.clientHeight) }
  return [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0 ? r : null
}
