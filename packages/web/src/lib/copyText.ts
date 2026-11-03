/**
 * copyText.ts — put text on the clipboard, on a phone too.
 *
 * `navigator.clipboard` exists only in a secure context, and the dashboard is routinely opened over
 * plain HTTP on the LAN (a phone hitting `http://192.168.x.x:47292`), where it is `undefined`. The
 * fallback is the old hidden-textarea + `execCommand('copy')`, which still works there. Resolves to
 * whether the text actually landed — a caller must not say "Copied" over a failure.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path (permission denied, document not focused)
  }
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.appendChild(ta)
  try {
    ta.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(ta)
  }
}
