/**
 * nativeAttachments.ts — PURE: attachments in the native composer (UI follow-up 3).
 *
 * The flow: the composer uploads each file through the host's existing door (`POST /api/fleet/attach`,
 * the chat attachment store) and sends the engine the stored NAMES with the message; the engine reads
 * them, judges them against the session's provider and attaches them as content parts. This module is
 * the browser's half of the policy — the same closed type table and the provider's declared limits
 * (`GET /api/runtime/sessions/:id` → `attachments`), checked BEFORE an upload so a file the provider
 * cannot take is refused in words at once rather than after a round trip. The engine checks again;
 * the browser is never the gate.
 */

/** What the session's provider declares it takes (the engine's `AttachmentCapability`), or null. */
export interface NativeAttachmentCapability {
  images: readonly string[]
  pdf: boolean
  maxImageBytes: number
  maxPdfBytes: number
  maxCount: number
  maxTotalBytes: number
}

export interface PickedFile { name: string; type: string; size: number }

const PDF = 'application/pdf'
const BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: PDF }

/** The file's media type: the browser's when it is one of ours, else by extension; null when neither. */
export function mediaTypeOf(f: Pick<PickedFile, 'name' | 'type'>): string | null {
  if (Object.values(BY_EXT).includes(f.type)) return f.type
  const m = /\.([A-Za-z0-9]+)$/.exec(f.name)
  return m ? BY_EXT[m[1]!.toLowerCase()] ?? null : null
}

/** The file input's `accept`, from the capability. */
export function acceptOf(cap: NativeAttachmentCapability): string {
  return [...cap.images, ...(cap.pdf ? [PDF] : [])].join(',')
}

const mb = (n: number) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`

/**
 * Why this file cannot be added, in the person's language — or null when it can. `already` is what the
 * message holds so far (count and total size count against the provider's limits).
 */
export function refuseFile(
  cap: NativeAttachmentCapability | null,
  f: PickedFile,
  already: readonly PickedFile[],
  providerLabel: string,
  lang: 'pt' | 'en',
): string | null {
  const pt = lang === 'pt'
  if (!cap) return pt ? `${providerLabel} não recebe anexos nesta sessão.` : `${providerLabel} does not take attachments in this session.`
  const type = mediaTypeOf(f)
  if (!type) return pt ? `"${f.name}" não é uma imagem (PNG, JPEG, GIF, WebP) nem um PDF.` : `"${f.name}" is not an image (PNG, JPEG, GIF, WebP) or a PDF.`
  const isPdf = type === PDF
  if (isPdf && !cap.pdf) return pt ? `${providerLabel} não recebe PDF.` : `${providerLabel} does not take PDFs.`
  if (!isPdf && !cap.images.includes(type)) return pt ? `${providerLabel} não recebe ${type}.` : `${providerLabel} does not take ${type}.`
  const max = isPdf ? cap.maxPdfBytes : cap.maxImageBytes
  if (f.size > max) return pt ? `"${f.name}" tem ${mb(f.size)}; o limite é ${mb(max)}.` : `"${f.name}" is ${mb(f.size)}; the limit is ${mb(max)}.`
  if (already.length + 1 > cap.maxCount) return pt ? `No máximo ${cap.maxCount} anexos por mensagem.` : `At most ${cap.maxCount} attachments per message.`
  const total = already.reduce((a, x) => a + x.size, f.size)
  if (total > cap.maxTotalBytes) return pt ? `Os anexos somam ${mb(total)}; uma mensagem leva até ${mb(cap.maxTotalBytes)}.` : `The attachments total ${mb(total)}; one message takes up to ${mb(cap.maxTotalBytes)}.`
  return null
}

/** Where the engine serves one of a session's attachments (by its content sha256). */
export function attachmentUrl(sessionId: string, ref: string): string {
  return `/api/runtime/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(ref)}`
}

/** Where the host serves an upload by its stored name (the composer's preview before sending). */
export function uploadPreviewUrl(name: string): string {
  return `/api/fleet/attachment/by-name?name=${encodeURIComponent(name)}`
}
