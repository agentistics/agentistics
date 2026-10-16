/** Durable fingerprints of messages delivered by the web composer. Text is never retained. */
import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
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

/** Keeps a short message ("ok", "sim") from being dictionary-reversible out of the file. */
const MAX_LINES = 2000
const LINE = /^[a-f0-9]{64}$/

function fingerprint(text: string, salt: string): string {
  // Claude replaces the composer's leading image paths with [Image #N]. Compare the
  // prose AND image count, so an image message cannot claim an unrelated text-only turn.
  const normalized = normalizeComposerText(text)
  const attachments = splitImageAttachments(normalized)
  const markers = splitImageMarkers(attachments.text)
  return hash(`${salt}${salt ? '\0' : ''}${attachments.images.length + markers.markers.length}\0${normalizeComposerText(markers.text)}`)
}

/**
 * Separate instances share only disk state, just as they do across a server restart.
 * Known limitation: the cache assumes ONE store per process. Two writers on the same directory can race
 * (one's cached set misses the other's append until the file signature changes); a display hint accepts that.
 */
export function createComposerMessageStore(directory: string) {
  // Hash ids as well: external ids and harness conversation ids need not be safe filenames.
  const pathFor = (id: string) => join(directory, `${hash(id)}.log`)
  const saltPath = join(directory, '.salt')
  let saltPromise: Promise<string> | undefined
  /** Per-install random salt, created once (0600). Unavailable disk degrades to unsalted lines. */
  const loadSalt = (): Promise<string> => saltPromise ??= (async () => {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      try { await writeFile(saltPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) } catch { /* exists */ }
      const value = (await readFile(saltPath, 'utf8')).trim()
      return /^[a-f0-9]{64}$/.test(value) ? value : ''
    } catch { return '' }
  })()

  // path -> parsed set, valid while the file's mtime/size are unchanged: no disk read per poll.
  const cache = new Map<string, { sig: string; values: Set<string>; lines: number }>()
  const sigOf = async (path: string) => { const st = await stat(path).catch(() => null); return st ? `${st.mtimeMs}:${st.size}` : '' }

  // One file operation at a time (reads that miss, trims, appends), so a trim can never overwrite a
  // concurrent append and two concurrent reads cannot both promote the same fingerprints.
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const job = queue.then(work)
    queue = job.catch(() => undefined)
    return job
  }

  /** Must run inside the queue. Caches only when the file did not change while it was read. */
  async function loadLocked(path: string): Promise<Set<string>> {
    const before = await sigOf(path)
    const hit = cache.get(path)
    if (hit && hit.sig === before) return hit.values
    const raw = before ? await readFile(path, 'utf8').catch(() => '') : ''
    // Ignore a partial or corrupt line, keeping every other record usable.
    let lines = raw.split('\n').filter(value => LINE.test(value))
    let trimmed = false
    if (lines.length > MAX_LINES) {
      trimmed = true
      lines = lines.slice(-MAX_LINES)
      try { await writeFile(path, `${lines.join('\n')}\n`, { mode: 0o600 }) } catch { /* trimming is best effort */ }
    }
    const values = new Set(lines)
    const after = await sigOf(path)
    // Any signature change other than our own trim means somebody wrote during the read: the set may
    // be incomplete, so do not publish it under the newer signature.
    if (trimmed || after === before) cache.set(path, { sig: after, values, lines: lines.length })
    else cache.delete(path)
    return values
  }
  /** Fast path without the queue when the signature still matches. */
  async function load(path: string): Promise<Set<string>> {
    const hit = cache.get(path)
    if (hit && hit.sig === await sigOf(path)) return hit.values
    return serial(() => loadLocked(path))
  }

  function append(id: string, values: string[]): Promise<void> {
    if (id === '' || values.length === 0) return Promise.resolve()
    return serial(async () => {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const path = pathFor(id)
        const present = await loadLocked(path)
        let physical = cache.get(path)?.lines ?? present.size
        const fresh = [...new Set(values)].filter(value => !present.has(value))
        if (fresh.length === 0) return
        await appendFile(path, `${fresh.join('\n')}\n`, { mode: 0o600 })
        for (const value of fresh) present.add(value)
        physical += fresh.length
        // The cap counts physical lines (a duplicate line is still a line on disk), not unique fingerprints.
        if (physical > MAX_LINES) {
          const kept = [...present].slice(-MAX_LINES)
          present.clear(); for (const value of kept) present.add(value)
          physical = kept.length
          try { await writeFile(path, `${kept.join('\n')}\n`, { mode: 0o600 }) } catch { /* best effort */ }
        }
        cache.set(path, { sig: await sigOf(path), values: present, lines: physical })
      } catch { /* A display hint must not turn a confirmed delivery into a send failure. */ }
    })
  }

  async function record(id: string, text: string): Promise<void> {
    if (id === '' || text.trim() === '') return
    await append(id, [fingerprint(text, await loadSalt())])
  }

  /** Cheap per call: a stat per file, a disk read only when a file changed. Keeps history up to MAX_LINES. */
  async function read(ids: string[], conversationId = ''): Promise<(text: string) => boolean> {
    const keys = [...new Set([...ids, conversationId].filter(Boolean))]
    const entries = await Promise.all(keys.map(id => load(pathFor(id))))
    const values = new Set(entries.flatMap(entry => [...entry]))
    // A first send may precede the harness conversation link. Promote its row-keyed
    // fingerprints when the link arrives, so reopening under a new row keeps the decision.
    if (conversationId !== '') {
      const canonical = entries[keys.indexOf(conversationId)]
      const missing = [...values].filter(value => !canonical?.has(value))
      if (missing.length) await append(conversationId, missing)
    }
    const salt = await loadSalt()
    // Lines written before the salt existed are unsalted: still accepted.
    return text => values.has(fingerprint(text, salt)) || values.has(fingerprint(text, ''))
  }

  return { record, read }
}

const store = createComposerMessageStore(join(AGENTISTICS_DATA_DIR, 'composer-messages'))
export const recordComposerMessage = store.record
export const readComposerMessages = store.read
