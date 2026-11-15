/**
 * browser-actions.ts — the browser verbs over raw CDP (NAVEGADOR S2, spec §1.1 / §5).
 *
 * Thin IO: each verb is a handful of CDP calls on ONE tab's flat session (auto-attached and
 * Fetch-intercepted by the host before it could run). Validation is `browser-action-spec.ts`; the text
 * a snapshot becomes is `ax-snapshot.ts`; who may call is `browser-gate.ts`. Nothing here decides a
 * block rule — a URL is checked through `ActionHost.blockReason` (the host's rule, DNS included) before
 * a navigation, and the interception refuses whatever the page itself reaches (redirects, iframes,
 * popups, fetch). When a navigation fails as `ERR_BLOCKED_BY_CLIENT`, the host's refusal log says why.
 *
 * Every result is `{ok:true,…}` or `{ok:false, error, sentence}` — the sentence is what the model reads.
 * A ref the page no longer has is `stale_ref`, never a crash.
 */

import { axSnapshot, boxesFromDomSnapshot, cleanText, parseRef, viewportRect } from './ax-snapshot'
import {
  FULLPAGE_MAX_HEIGHT, WAIT_MAX_MS, blockSentence, evaluateResult, keyDef, ownUrl, truncateUtf8,
  type ActionArgs,
} from './browser-action-spec'
import type { BlockReason } from './browser-spec'
import { statusTitle } from './browser-spec'
import type { CdpClient } from './cdp-client'

export interface BlockedHit {
  url: string
  reason: BlockReason
  resourceType: string
  redirect: boolean
  /** The page target whose request it was, when known. */
  page: string | null
  at: number
}

export interface LastAction { kind: string; label: string; x?: number; y?: number; at: number }

/** One live browser, as the verbs see it (the host implements it). */
export interface ActionHost {
  cdp: CdpClient
  ownerKind: 'session' | 'personal'
  maxTabs: number
  tabs(): { targetId: string; url: string; title: string; active: boolean }[]
  activeTab(): string | null
  setActive(targetId: string): void
  noteTab(targetId: string, url: string, title: string): void
  /** The tab's flat CDP session (attaching and intercepting it first when needed). */
  sessionFor(targetId: string): Promise<string>
  /** Wait (bounded) for a new tab's auto-attach to land. */
  waitTab(targetId: string, ms: number): Promise<void>
  blockedSince(ms: number): BlockedHit[]
  blockReason(url: string): Promise<BlockReason | null>
  noteAction(a: LastAction): void
  touch(): void
  now(): number
}

export type ActionResult =
  | ({ ok: true } & Record<string, unknown>)
  | ({ ok: false; error: string; sentence: string } & Record<string, unknown>)

const fail = (error: string, sentence: string, extra: Record<string, unknown> = {}): ActionResult => ({ ok: false, error, sentence, ...extra })

const NAV_TIMEOUT_MS = 15_000

/** Run one validated action. `close` is the route's (it stops the browser), not this module's. */
export async function runAction(h: ActionHost, args: ActionArgs): Promise<ActionResult> {
  h.touch()
  try {
    switch (args.action) {
      case 'tabs': return { ok: true, tabs: tabList(h) }
      case 'tab_new': return await tabNew(h, args.url)
      case 'tab_select': return await tabSelect(h, args.tab)
      case 'tab_close': return await tabClose(h, args.tab)
      case 'close': return fail('bad_request', 'close is handled by the route.')
      default: break
    }
    const tab = await resolveTab(h, 'tab' in args ? args.tab : undefined)
    if (!tab.ok) return tab.result
    const targetId = tab.targetId
    const sid = await h.sessionFor(targetId)
    switch (args.action) {
      case 'navigate': return await navigate(h, targetId, sid, args.url)
      case 'back': case 'forward': return await history(h, targetId, sid, args.action)
      case 'reload': return await reload(h, targetId, sid)
      case 'click': return await click(h, targetId, sid, args)
      case 'type': return await typeInto(h, targetId, sid, args.ref, args.text, args.submit)
      case 'press': return await press(h, targetId, sid, args.key)
      case 'select': return await selectIn(h, targetId, sid, args.ref, args.values)
      case 'scroll': return await scroll(h, targetId, sid, args)
      case 'evaluate': return await evaluate(h, targetId, sid, args.expression)
      case 'snapshot': return await snapshot(h, targetId, sid, args.mode, args.maxBytes)
      case 'screenshot': return await screenshot(h, targetId, sid, args.fullPage, args.format)
      case 'wait_for': return await waitFor(h, targetId, sid, args)
    }
  } catch (e) {
    return fromCdpError(e)
  }
}

/** A CDP failure in words. A missing node is a stale ref — the page changed since the snapshot. */
export function fromCdpError(e: unknown): ActionResult {
  const msg = e instanceof Error ? e.message : String(e)
  if (/No node with given id|Could not find node|Node is detached|No node found|Cannot find context|does not belong to the document|Could not compute (box model|content quads)/i.test(msg)) {
    return fail('stale_ref', 'That ref is not on the page any more (it changed since the snapshot). Take a new agentistics_browser_snapshot.')
  }
  if (/connection closed/i.test(msg)) return fail('browser_gone', 'The browser stopped while acting. Call the tool again to start a fresh one.')
  if (/timed out/i.test(msg)) return fail('timeout', 'The browser did not answer in time.')
  return fail('cdp_error', `The browser refused the action: ${cleanText(msg, 200)}`)
}

function tabList(h: ActionHost) {
  return h.tabs().map(t => ({ tab: t.targetId, url: ownUrl(t.url), title: statusTitle(t.title), active: t.active }))
}

async function resolveTab(h: ActionHost, tab: string | undefined): Promise<{ ok: true; targetId: string } | { ok: false; result: ActionResult }> {
  if (tab) {
    if (!h.tabs().some(t => t.targetId === tab)) return { ok: false, result: fail('no_such_tab', `No tab ${tab} in this browser. agentistics_browser_tabs lists them.`) }
    return { ok: true, targetId: tab }
  }
  const active = h.activeTab()
  if (active) return { ok: true, targetId: active }
  const { targetId } = await h.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
  await h.waitTab(targetId, 2_000)
  h.setActive(targetId)
  return { ok: true, targetId }
}

async function pageInfo(h: ActionHost, targetId: string, sid: string): Promise<{ url: string; title: string }> {
  try {
    const r = await h.cdp.send<{ result: { value?: { url: string; title: string } } }>(
      'Runtime.evaluate', { expression: '({url: location.href, title: document.title})', returnByValue: true }, sid, 5_000)
    const v = r.result?.value ?? { url: '', title: '' }
    h.noteTab(targetId, v.url, v.title)
    return { url: ownUrl(v.url), title: statusTitle(v.title) }
  } catch {
    const t = h.tabs().find(x => x.targetId === targetId)
    return { url: ownUrl(t?.url ?? ''), title: statusTitle(t?.title ?? '') }
  }
}

/** Resolve when the tab's next load fires, or after `ms`. */
function nextLoad(h: ActionHost, sid: string, ms: number): Promise<void> {
  return new Promise((res) => {
    const off = h.cdp.on((ev) => {
      if (ev.sessionId === sid && (ev.method === 'Page.loadEventFired' || ev.method === 'Page.navigatedWithinDocument')) { off(); clearTimeout(t); res() }
    })
    const t = setTimeout(() => { off(); res() }, ms)
  })
}

/** The refusal behind a failed navigation, from the host's log of what the interception blocked. */
function blockedResult(h: ActionHost, since: number, targetId: string, asked: string): ActionResult | null {
  const hit = h.blockedSince(since).find(b => b.page === targetId || b.page === null)
  if (!hit) return null
  return fail('blocked', blockSentence(hit.reason, hit.redirect ? hit.url : ownUrl(asked), hit.redirect ? 'redirect' : undefined),
    { reason: hit.reason, url: hit.url, redirect: hit.redirect })
}

async function navigate(h: ActionHost, targetId: string, sid: string, url: string): Promise<ActionResult> {
  const reason = await h.blockReason(url)
  if (reason) return fail('blocked', blockSentence(reason, ownUrl(url)), { reason, url: ownUrl(url) })
  const since = h.now()
  const loaded = nextLoad(h, sid, NAV_TIMEOUT_MS)
  const nav = await h.cdp.send<{ errorText?: string; loaderId?: string }>('Page.navigate', { url }, sid, NAV_TIMEOUT_MS)
  if (nav.errorText) {
    const b = /BLOCKED_BY_CLIENT/.test(nav.errorText) ? blockedResult(h, since, targetId, url) : null
    return b ?? fail('navigation_failed', `The page did not load: ${cleanText(nav.errorText, 120)}.`)
  }
  if (nav.loaderId) await loaded
  h.setActive(targetId)
  const info = await pageInfo(h, targetId, sid)
  h.noteAction({ kind: 'navigate', label: info.url, at: h.now() })
  return { ok: true, tab: targetId, ...info }
}

async function history(h: ActionHost, targetId: string, sid: string, dir: 'back' | 'forward'): Promise<ActionResult> {
  const hist = await h.cdp.send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory', {}, sid)
  const idx = hist.currentIndex + (dir === 'back' ? -1 : 1)
  const entry = hist.entries[idx]
  if (!entry) return fail('no_history', dir === 'back' ? 'There is no page to go back to.' : 'There is no page to go forward to.')
  const reason = await h.blockReason(entry.url)
  if (reason) return fail('blocked', blockSentence(reason, ownUrl(entry.url)), { reason })
  const loaded = nextLoad(h, sid, NAV_TIMEOUT_MS)
  await h.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sid)
  await loaded
  const info = await pageInfo(h, targetId, sid)
  h.noteAction({ kind: dir, label: info.url, at: h.now() })
  return { ok: true, tab: targetId, ...info }
}

async function reload(h: ActionHost, targetId: string, sid: string): Promise<ActionResult> {
  const loaded = nextLoad(h, sid, NAV_TIMEOUT_MS)
  await h.cdp.send('Page.reload', {}, sid)
  await loaded
  const info = await pageInfo(h, targetId, sid)
  h.noteAction({ kind: 'reload', label: info.url, at: h.now() })
  return { ok: true, tab: targetId, ...info }
}

async function nodeLabel(h: ActionHost, sid: string, backendNodeId: number): Promise<string> {
  try {
    const r = await h.cdp.send<{ nodes: { name?: { value?: unknown }; role?: { value?: unknown } }[] }>(
      'Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false }, sid, 5_000)
    const n = r.nodes?.[0]
    return cleanText(n?.name?.value, 80) || cleanText(n?.role?.value, 40)
  } catch { return '' }
}

/** The centre of a node's first content quad, after scrolling it into view. */
async function pointOf(h: ActionHost, sid: string, backendNodeId: number): Promise<{ x: number; y: number }> {
  await h.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, sid).catch(() => {})
  try {
    const { quads } = await h.cdp.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId }, sid)
    const q = quads?.[0]
    if (q && q.length >= 8) return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 }
  } catch (e) {
    if (!/Could not compute content quads/i.test(String(e))) throw e
  }
  const { model } = await h.cdp.send<{ model: { content: number[] } }>('DOM.getBoxModel', { backendNodeId }, sid)
  const c = model.content
  return { x: (c[0]! + c[2]! + c[4]! + c[6]!) / 4, y: (c[1]! + c[3]! + c[5]! + c[7]!) / 4 }
}

async function click(h: ActionHost, targetId: string, sid: string, a: Extract<ActionArgs, { action: 'click' }>): Promise<ActionResult> {
  let x: number, y: number, label = ''
  if (a.ref) {
    const id = parseRef(a.ref)!
    ;({ x, y } = await pointOf(h, sid, id))
    label = await nodeLabel(h, sid, id)
  } else { x = a.x!; y = a.y! }
  const since = h.now()
  const send = (type: string, clickCount: number) => h.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: a.button, clickCount, buttons: type === 'mousePressed' ? 1 : 0 }, sid)
  await h.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid)
  await send('mousePressed', 1); await send('mouseReleased', 1)
  if (a.double) { await send('mousePressed', 2); await send('mouseReleased', 2) }
  h.noteAction({ kind: 'click', label: label || `${Math.round(x)},${Math.round(y)}`, x, y, at: h.now() })
  await new Promise(r => setTimeout(r, 150))
  const info = await pageInfo(h, targetId, sid)
  const b = blockedResult(h, since, targetId, info.url)
  return { ok: true, tab: targetId, clicked: label, x: Math.round(x), y: Math.round(y), ...info, ...(b && !b.ok ? { refused: b.sentence } : {}) }
}

async function objectOf(h: ActionHost, sid: string, ref: string): Promise<string> {
  const { object } = await h.cdp.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: parseRef(ref)! }, sid)
  return object.objectId
}

async function pressKey(h: ActionHost, sid: string, key: string): Promise<void> {
  const k = keyDef(key)!
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode }
  await h.cdp.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) }, sid)
  await h.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sid)
}

async function typeInto(h: ActionHost, targetId: string, sid: string, ref: string, text: string, submit: boolean): Promise<ActionResult> {
  const id = parseRef(ref)!
  await h.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: id }, sid).catch(() => {})
  await h.cdp.send('DOM.focus', { backendNodeId: id }, sid)
  const objectId = await objectOf(h, sid, ref)
  // Fill semantics: what was in the field is replaced (a model re-typing must not append).
  await h.cdp.send('Runtime.callFunctionOn', {
    objectId, returnByValue: true,
    functionDeclaration: 'function(){ if ("value" in this && typeof this.select === "function") { this.select(); } else if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }',
  }, sid)
  if (text.length) await h.cdp.send('Input.insertText', { text }, sid)
  else await pressKey(h, sid, 'Backspace')
  const label = await nodeLabel(h, sid, id)
  h.noteAction({ kind: 'type', label, at: h.now() })
  if (submit) {
    const loaded = nextLoad(h, sid, 3_000)
    await pressKey(h, sid, 'Enter')
    await loaded
  }
  const info = await pageInfo(h, targetId, sid)
  return { ok: true, tab: targetId, typedInto: label, chars: [...text].length, submitted: submit, ...info }
}

async function press(h: ActionHost, targetId: string, sid: string, key: string): Promise<ActionResult> {
  await pressKey(h, sid, key)
  h.noteAction({ kind: 'press', label: key, at: h.now() })
  await new Promise(r => setTimeout(r, 100))
  return { ok: true, tab: targetId, pressed: key, ...(await pageInfo(h, targetId, sid)) }
}

async function selectIn(h: ActionHost, targetId: string, sid: string, ref: string, values: string[]): Promise<ActionResult> {
  const objectId = await objectOf(h, sid, ref)
  const r = await h.cdp.send<{ result: { value?: number | string }; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
    objectId, returnByValue: true, arguments: [{ value: values }],
    functionDeclaration: 'function(vals){ if (this.tagName !== "SELECT") return "not-select"; const want = new Set(vals); let n = 0; for (const o of this.options) { const on = want.has(o.value) || want.has(o.label) || want.has(o.text); if (on && !this.multiple && n > 0) continue; o.selected = on; if (on) n++; } this.dispatchEvent(new Event("input", {bubbles: true})); this.dispatchEvent(new Event("change", {bubbles: true})); return n; }',
  }, sid)
  const v = r.result?.value
  if (v === 'not-select') return fail('not_select', 'That ref is not a <select>. For a custom dropdown, click it and then click the option.')
  if (v === 0) return fail('no_option', 'No option of that <select> matches those values or labels.')
  const label = await nodeLabel(h, sid, parseRef(ref)!)
  h.noteAction({ kind: 'select', label, at: h.now() })
  return { ok: true, tab: targetId, selected: v, ...(await pageInfo(h, targetId, sid)) }
}

async function scroll(h: ActionHost, targetId: string, sid: string, a: Extract<ActionArgs, { action: 'scroll' }>): Promise<ActionResult> {
  if (a.ref) {
    await h.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: parseRef(a.ref)! }, sid)
  } else {
    const m = await h.cdp.send<unknown>('Page.getLayoutMetrics', {}, sid)
    const vp = viewportRect(m)
    const x = vp ? vp.w / 2 : 400, y = vp ? vp.h / 2 : 300
    await h.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: a.dx, deltaY: a.dy }, sid)
    await new Promise(r => setTimeout(r, 120))
  }
  h.noteAction({ kind: 'scroll', label: a.ref ?? `${a.dx},${a.dy}`, at: h.now() })
  const pos = await h.cdp.send<{ result: { value?: { x: number; y: number; h: number; vh: number } } }>('Runtime.evaluate', {
    expression: '({x: scrollX, y: scrollY, h: document.documentElement.scrollHeight, vh: innerHeight})', returnByValue: true,
  }, sid)
  return { ok: true, tab: targetId, scroll: pos.result?.value ?? null }
}

async function evaluate(h: ActionHost, targetId: string, sid: string, expression: string): Promise<ActionResult> {
  const r = await h.cdp.send<{ result: { type?: string; value?: unknown; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
    'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: 10_000 }, sid, 15_000)
  h.noteAction({ kind: 'evaluate', label: 'script', at: h.now() })
  if (r.exceptionDetails) {
    const msg = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'exception'
    return fail('script_error', `The expression threw: ${truncateUtf8(cleanText(msg, 2000), 2000).text}`)
  }
  const out = evaluateResult(r.result?.value, r.result?.type)
  return { ok: true, tab: targetId, value: out.value, truncated: out.truncated, bytes: out.bytes }
}

async function snapshot(h: ActionHost, targetId: string, sid: string, mode: 'full' | 'viewport', maxBytes?: number): Promise<ActionResult> {
  const info = await pageInfo(h, targetId, sid)
  const { nodes } = await h.cdp.send<{ nodes: any[] }>('Accessibility.getFullAXTree', {}, sid, 20_000)
  let viewport: { rect: { x: number; y: number; w: number; h: number }; boxes: Map<number, any> } | null = null
  if (mode === 'viewport') {
    const [snap, metrics] = await Promise.all([
      h.cdp.send<unknown>('DOMSnapshot.captureSnapshot', { computedStyles: [] }, sid, 20_000),
      h.cdp.send<unknown>('Page.getLayoutMetrics', {}, sid),
    ])
    const rect = viewportRect(metrics)
    if (rect) viewport = { rect, boxes: boxesFromDomSnapshot(snap) }
  }
  const s = axSnapshot(nodes ?? [], {
    maxBytes, viewport,
    header: [`url: ${info.url}`, `title: ${info.title}`, `tab: ${targetId}${mode === 'viewport' ? ' (viewport only)' : ''}`],
  })
  return { ok: true, tab: targetId, ...info, mode, snapshot: s.text, truncated: s.truncated, refs: Object.keys(s.refs).length, omittedRefs: s.omittedRefs, bytes: s.bytes }
}

async function screenshot(h: ActionHost, targetId: string, sid: string, fullPage: boolean, format: 'png' | 'jpeg'): Promise<ActionResult> {
  const params: Record<string, unknown> = { format, ...(format === 'jpeg' ? { quality: 70 } : {}) }
  let width: number | null = null, height: number | null = null
  if (fullPage) {
    const m = await h.cdp.send<{ cssContentSize?: { width: number; height: number } }>('Page.getLayoutMetrics', {}, sid)
    const w = Math.min(Math.ceil(m.cssContentSize?.width ?? 1280), 4000)
    const ht = Math.min(Math.ceil(m.cssContentSize?.height ?? 800), FULLPAGE_MAX_HEIGHT)
    params.captureBeyondViewport = true
    params.clip = { x: 0, y: 0, width: w, height: ht, scale: 1 }
    width = w; height = ht
  }
  let r = await h.cdp.send<{ data: string }>('Page.captureScreenshot', params, sid, 20_000)
  let mime = format === 'png' ? 'image/png' : 'image/jpeg'
  if (r.data.length > 6_000_000) {
    r = await h.cdp.send<{ data: string }>('Page.captureScreenshot', { ...params, format: 'jpeg', quality: 50 }, sid, 20_000)
    mime = 'image/jpeg'
  }
  return { ok: true, tab: targetId, mime, data: r.data, bytes: Math.floor(r.data.length * 3 / 4), ...(width ? { width, height, clippedAt: FULLPAGE_MAX_HEIGHT } : {}) }
}

async function waitFor(h: ActionHost, targetId: string, sid: string, a: Extract<ActionArgs, { action: 'wait_for' }>): Promise<ActionResult> {
  const started = Date.now()
  if (a.ms !== undefined) {
    await new Promise(r => setTimeout(r, Math.min(a.ms!, WAIT_MAX_MS)))
    return { ok: true, tab: targetId, waitedMs: Date.now() - started }
  }
  const limit = Math.min(a.timeoutMs, WAIT_MAX_MS)
  for (;;) {
    let found = false
    if (a.text !== undefined) {
      const r = await h.cdp.send<{ result: { value?: boolean } }>('Runtime.evaluate', {
        expression: `(document.body ? document.body.innerText : '').includes(${JSON.stringify(a.text)})`, returnByValue: true,
      }, sid).catch(() => ({ result: { value: false } }))
      found = r.result?.value === true
    } else {
      found = await h.cdp.send('DOM.describeNode', { backendNodeId: parseRef(a.ref!)! }, sid).then(() => true, () => false)
    }
    if (found) return { ok: true, tab: targetId, found: true, waitedMs: Date.now() - started }
    if (Date.now() - started >= limit) return { ok: true, tab: targetId, found: false, waitedMs: Date.now() - started }
    await new Promise(r => setTimeout(r, 200))
  }
}

async function tabNew(h: ActionHost, url: string | undefined): Promise<ActionResult> {
  if (h.tabs().length >= h.maxTabs) return fail('tab_ceiling', `This browser already has ${h.maxTabs} tabs. Close one with agentistics_browser_tab_close first.`)
  if (url) {
    const reason = await h.blockReason(url)
    if (reason) return fail('blocked', blockSentence(reason, ownUrl(url)), { reason })
  }
  const { targetId } = await h.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
  await h.waitTab(targetId, 2_000)
  h.setActive(targetId)
  if (!url) return { ok: true, tab: targetId, url: 'about:blank', title: '' }
  const sid = await h.sessionFor(targetId)
  return navigate(h, targetId, sid, url)
}

async function tabSelect(h: ActionHost, tab: string): Promise<ActionResult> {
  if (!h.tabs().some(t => t.targetId === tab)) return fail('no_such_tab', `No tab ${tab} in this browser. agentistics_browser_tabs lists them.`)
  await h.cdp.send('Target.activateTarget', { targetId: tab }).catch(() => {})
  h.setActive(tab)
  h.noteAction({ kind: 'tab_select', label: tab, at: h.now() })
  return { ok: true, tab, tabs: tabList(h) }
}

async function tabClose(h: ActionHost, tab: string): Promise<ActionResult> {
  if (!h.tabs().some(t => t.targetId === tab)) return fail('no_such_tab', `No tab ${tab} in this browser. agentistics_browser_tabs lists them.`)
  await h.cdp.send('Target.closeTarget', { targetId: tab })
  // The destroyed event updates the host's map; wait for it briefly so the list returned is the new one.
  const started = Date.now()
  while (h.tabs().some(t => t.targetId === tab) && Date.now() - started < 1_000) await new Promise(r => setTimeout(r, 25))
  h.noteAction({ kind: 'tab_close', label: tab, at: h.now() })
  return { ok: true, closed: tab, tabs: tabList(h) }
}
