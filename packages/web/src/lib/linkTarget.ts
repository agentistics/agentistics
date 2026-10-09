/**
 * linkTarget.ts — PURE-ish (DOM read only). The `href` of the link an event landed on, if any.
 *
 * A right click or long press on a link inside a message opens the message menu; this says whether
 * the menu should lead with the link's own entries. Only http(s)/mailto links count: a `javascript:`
 * URL must never be offered to "open in a new tab".
 */
export function linkHrefFrom(target: EventTarget | null): string | null {
  const el = target as { closest?: (s: string) => { getAttribute(n: string): string | null } | null } | null
  const a = el && typeof el.closest === 'function' ? el.closest('a[href]') : null
  const href = a?.getAttribute('href')?.trim()
  if (!href) return null
  return /^(https?:|mailto:|\/|#)/i.test(href) ? href : null
}
