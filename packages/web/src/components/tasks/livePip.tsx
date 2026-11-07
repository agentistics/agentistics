/**
 * livePip — open the Live view in a window of its own, so it can sit on another monitor.
 *
 * Chrome's Document Picture-in-Picture gives a small always-on-top window whose document we fill
 * with the SAME React tree (a portal), so it keeps updating from the same streams. Where it does not
 * exist (Safari / WebKit, Firefox) the fallback is a plain small `window.open` of the Live route.
 *
 * NOTE (decision, 2026-11-06): the brief said to reuse the voice-call PiP; this base has none (no
 * `documentPictureInPicture` anywhere), so this is the one implementation — a later voice PiP should
 * import `requestPipWindow` from here rather than write a second.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

interface PipApi { requestWindow(o?: { width?: number; height?: number }): Promise<Window> }
const pipApi = (): PipApi | null => {
  try { return (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture ?? null } catch { return null }
}

export const pipSupported = (): boolean => pipApi() !== null

/** Copy every stylesheet of this document into the new one, so the tree looks the same out there. */
export function copyStyles(from: Document, to: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules).map(r => r.cssText).join('\n')
      const el = to.createElement('style')
      el.textContent = css
      to.head.appendChild(el)
    } catch {
      // A cross-origin sheet cannot be read: link it instead.
      if (sheet.href) {
        const link = to.createElement('link')
        link.rel = 'stylesheet'
        link.href = sheet.href
        to.head.appendChild(link)
      }
    }
  }
  for (const attr of ['class', 'data-theme', 'style']) {
    const v = from.documentElement.getAttribute(attr)
    if (v !== null) to.documentElement.setAttribute(attr, v)
  }
  // The new window has no text-size zoom of its own: size by the document, never by a viewport unit.
  to.documentElement.style.height = '100%'
  to.body.style.cssText += ';margin:0;height:100%'
  to.body.className = from.body.className
}

export type OpenedWindow = { kind: 'pip'; win: Window } | { kind: 'popup' } | { kind: 'blocked' }

/** Open the external window: Document PiP when the browser has it, else a small popup of `fallbackUrl`. */
export async function requestPipWindow(o: { width: number; height: number; fallbackUrl: string }): Promise<OpenedWindow> {
  const api = pipApi()
  if (api) {
    try {
      const win = await api.requestWindow({ width: o.width, height: o.height })
      copyStyles(document, win.document)
      return { kind: 'pip', win }
    } catch { /* refused (no user gesture, or already open): fall through to the popup */ }
  }
  const w = window.open(o.fallbackUrl, 'agentistics-live', `popup=yes,width=${o.width},height=${o.height}`)
  return w ? { kind: 'popup' } : { kind: 'blocked' }
}

/** Renders `children` inside a PiP window, and reports when the person closes it. */
export function PipPortal({ win, onClose, children }: { win: Window; onClose: () => void; children: React.ReactNode }) {
  const [host] = useState(() => {
    const d = win.document.createElement('div')
    d.style.cssText = 'height:100%;box-sizing:border-box;padding:10px;overflow:hidden;background:var(--bg-surface);color:var(--text-primary);font-family:inherit'
    win.document.body.appendChild(d)
    return d
  })
  useEffect(() => {
    const done = () => onClose()
    win.addEventListener('pagehide', done)
    return () => win.removeEventListener('pagehide', done)
  }, [win, onClose])
  return createPortal(children, host)
}
