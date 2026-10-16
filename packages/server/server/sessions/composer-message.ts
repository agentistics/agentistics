/** Durable fingerprints of messages delivered by the web composer. Text is never retained. */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { splitImageAttachments, splitImageMarkers } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR } from '../config'

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

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function fingerprint(text: string): string {
  // Claude replaces the composer's leading image paths with [Image #N]. Compare the
  // prose AND image count, so an image message cannot claim an unrelated text-only turn.
  const normalized = normalizeComposerText(text)
  const attachments = splitImageAttachments(normalized)
  const markers = splitImageMarkers(attachments.text)
  return hash(`${attachments.images.length + markers.markers.length}\0${normalizeComposerText(markers.text)}`)
}

/** Separate instances share only disk state, just as they do across a server restart. */
export function createComposerMessageStore(directory: string) {
  // Hash ids as well: external ids and harness conversation ids need not be safe filenames.
  const pathFor = (id: string) => join(directory, `${hash(id)}.log`)

  async function append(id: string, values: string[]): Promise<void> {
    if (id === '' || values.length === 0) return
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await appendFile(pathFor(id), `${values.join('\n')}\n`, { mode: 0o600 })
    } catch { /* A display hint must not turn a confirmed delivery into a send failure. */ }
  }

  async function record(id: string, text: string): Promise<void> {
    if (id === '' || text.trim() === '') return
    await append(id, [fingerprint(text)])
  }

  /** Read once per chat load, never once per turn. Keep all history, without a TTL or send cap. */
  async function read(ids: string[], conversationId = ''): Promise<(text: string) => boolean> {
    const keys = [...new Set([...ids, conversationId].filter(Boolean))]
    const entries = await Promise.all(keys.map(async id => {
      const raw = await readFile(pathFor(id), 'utf8').catch(() => '')
      // Ignore a partial or corrupt line, keeping every other record usable.
      return new Set(raw.split('\n').filter(value => /^[a-f0-9]{64}$/.test(value)))
    }))
    const values = new Set(entries.flatMap(entry => [...entry]))
    // A first send may precede the harness conversation link. Promote its row-keyed
    // fingerprints when the link arrives, so reopening under a new row keeps the decision.
    const canonical = entries[keys.indexOf(conversationId)]
    if (conversationId !== '') {
      await append(conversationId, [...values].filter(value => !canonical?.has(value)))
    }
    return text => values.has(fingerprint(text))
  }

  return { record, read }
}

const store = createComposerMessageStore(join(AGENTISTICS_DATA_DIR, 'composer-messages'))
export const recordComposerMessage = store.record
export const readComposerMessages = store.read
