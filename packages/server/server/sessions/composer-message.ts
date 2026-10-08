/** Fingerprints of messages delivered by the web composer. Text is never retained. */
import { createHash } from 'node:crypto'

export const COMPOSER_MESSAGE_TTL_MS = 10 * 60_000
const MAX_PER_SESSION = 50

type Fingerprint = { value: string; expiresAt: number }
const sent = new Map<string, Fingerprint[]>()

/** Match transcript formatting without retaining the message itself. */
export function normalizeComposerText(text: string): string {
  return text
    .replace(/<pasted_content(?:\s+id="[^"]*")?\s*>/gi, '')
    .replace(/<\/pasted_content(?:\s+id="[^"]*")?\s*>/gi, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function fingerprint(sessionId: string, text: string): string {
  return createHash('sha256').update(sessionId).update('\0').update(normalizeComposerText(text)).digest('hex')
}

export function recordComposerMessage(sessionId: string, text: string, now = Date.now()): void {
  if (sessionId === '' || text.trim() === '') return
  const list = (sent.get(sessionId) ?? []).filter(f => f.expiresAt > now)
  list.push({ value: fingerprint(sessionId, text), expiresAt: now + COMPOSER_MESSAGE_TTL_MS })
  sent.set(sessionId, list.slice(-MAX_PER_SESSION))
}

export function isComposerMessage(sessionId: string, text: string, now = Date.now()): boolean {
  const list = sent.get(sessionId)
  if (!list) return false
  const fresh = list.filter(f => f.expiresAt > now)
  if (fresh.length === 0) sent.delete(sessionId)
  else sent.set(sessionId, fresh)
  const value = fingerprint(sessionId, text)
  return fresh.some(f => f.value === value)
}

export function resetComposerMessages(): void {
  sent.clear()
}
