/**
 * delivery/guard-integrity.ts — the seal on `guards.json` and `guarantees.json` (ENTREGA.GARANTIDA S0d.2, QA F2).
 *
 * QA 13/11: both files were plain JSON, so a worker that edits `~/.agentistics/*.json` (§1.1) could delete
 * `guarantees.json` (every rule silently `off`), rewrite a rule to `on` with a forged owner log line, or plant a rank-5
 * checkpoint claiming a vault proof. Now each document carries `integrity: { v: 1, mac }`,
 * `mac = HMAC-SHA256(key, "<document name>\0" + canonical JSON of the document without integrity)` — the name binds the
 * MAC to ONE file, so one cannot be swapped for the other.
 *
 * THE KEY is `<dataDir>/guard-integrity.key` (0600, not a `.json`): 32 random bytes plus the list of documents ever sealed
 * with it, so a document that VANISHED is told apart from one that never existed. It is created by the first sealed
 * write and excluded from backups by the `.key` secret rule.
 *
 * Stated limit (spec S0d.2): a same-uid process that reads the key file can compute a MAC. This closes the
 * `*.json`-edit capability of §1.1 and every deletion or edit that does not also read a key file.
 *
 * PURE except the three IO helpers at the bottom.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const GUARD_KEY_FILE = 'guard-integrity.key'
const KEY_HEADER = 'agentistics-guard-integrity v1'
export type IntegrityDocName = 'guards' | 'guarantees'
const DOC_NAMES: readonly IntegrityDocName[] = ['guards', 'guarantees']

export interface IntegrityKey { key: Buffer; sealed: ReadonlySet<IntegrityDocName> }
export type TamperReason = 'unsealed' | 'forged' | 'missing' | 'key-missing' | 'key-unreadable'
export type IntegrityVerdict = { state: 'ok' } | { state: 'fresh' } | { state: 'tampered'; reason: TamperReason }

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** PURE. JSON with every object's keys sorted, so the MAC does not depend on property order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isRec(v)) return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/** PURE. The MAC of `doc` (its own `integrity` field ignored) as document `name`. */
export function docMac(key: Buffer, name: IntegrityDocName, doc: Record<string, unknown>): string {
  const { integrity: _i, ...body } = doc
  return createHmac('sha256', key).update(`${name}\0${canonicalJson(body)}`).digest('base64url')
}

/** PURE. `doc` with its seal. */
export function sealDoc<T extends object>(key: Buffer, name: IntegrityDocName, doc: T): T & { integrity: { v: 1; mac: string } } {
  const { integrity: _i, ...body } = doc as Record<string, unknown>
  return { ...(body as T), integrity: { v: 1, mac: docMac(key, name, body) } }
}

/**
 * PURE. What a document's bytes say, given the key (null = no key file).
 *   no text:  no key → fresh; the key says it was sealed → missing; else fresh.
 *   text:     no key → key-missing; no/garbled `integrity` (or not JSON) → unsealed; wrong MAC → forged.
 */
export function checkIntegrity(key: IntegrityKey | null, name: IntegrityDocName, text: string | null): IntegrityVerdict {
  if (text === null) return key?.sealed.has(name) ? { state: 'tampered', reason: 'missing' } : { state: 'fresh' }
  if (!key) return { state: 'tampered', reason: 'key-missing' }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { state: 'tampered', reason: 'unsealed' } }
  if (!isRec(raw) || !isRec(raw.integrity) || raw.integrity.v !== 1 || typeof raw.integrity.mac !== 'string') return { state: 'tampered', reason: 'unsealed' }
  const want = Buffer.from(docMac(key.key, name, raw)), got = Buffer.from(raw.integrity.mac)
  return want.length === got.length && timingSafeEqual(want, got) ? { state: 'ok' } : { state: 'tampered', reason: 'forged' }
}

/** PURE. The key file's text. */
export function formatKeyFile(k: IntegrityKey): string {
  return `${KEY_HEADER}\n${k.key.toString('base64')}\n${DOC_NAMES.filter(n => k.sealed.has(n)).join(',')}\n`
}

/** PURE. `null` for anything that is not exactly a key file. */
export function parseKeyFile(text: string): IntegrityKey | null {
  const [head, b64, list = ''] = text.split('\n')
  if (head !== KEY_HEADER || !b64) return null
  const key = Buffer.from(b64, 'base64')
  if (key.length !== 32) return null
  const sealed = new Set<IntegrityDocName>()
  for (const n of list.split(',').filter(Boolean)) { if (!DOC_NAMES.includes(n as IntegrityDocName)) return null; sealed.add(n as IntegrityDocName) }
  return { key, sealed }
}

export const keyPathFor = (docPath: string): string => join(dirname(docPath), GUARD_KEY_FILE)

/** IO. The key beside `docPath`: `null` when there is none; `'unreadable'` when a file is there and is not a key. */
export async function loadIntegrityKey(docPath: string): Promise<IntegrityKey | null | 'unreadable'> {
  let text: string
  try { text = await readFile(keyPathFor(docPath), 'utf8') } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'
  }
  return parseKeyFile(text) ?? 'unreadable'
}

/** IO. The verdict for the document at `docPath` (its text, or null when absent). */
export async function verdictFor(docPath: string, name: IntegrityDocName, text: string | null): Promise<IntegrityVerdict> {
  const k = await loadIntegrityKey(docPath)
  if (k === 'unreadable') return { state: 'tampered', reason: 'key-unreadable' }
  return checkIntegrity(k, name, text)
}

/**
 * IO. Seal `doc` as `name` and write it atomically (0600), creating the key on first use and recording that `name` is
 * now sealed BEFORE the document lands (so a crash leaves "sealed but missing" = fail closed, never "unsealed and fine").
 * Throws when the key file exists but is unreadable — nothing replaces it.
 */
export async function writeSealed(docPath: string, name: IntegrityDocName, doc: object): Promise<void> {
  await mkdir(dirname(docPath), { recursive: true })
  const found = await loadIntegrityKey(docPath)
  if (found === 'unreadable') throw new Error(`${GUARD_KEY_FILE} is unreadable; ${name}.json was not written`)
  let key = found
  if (!key || !key.sealed.has(name)) {
    key = { key: key?.key ?? randomBytes(32), sealed: new Set([...(key?.sealed ?? []), name]) }
    const kp = keyPathFor(docPath), tmp = `${kp}.tmp-${process.pid}`
    await writeFile(tmp, formatKeyFile(key), { mode: 0o600 })
    await rename(tmp, kp)
  }
  const tmp = `${docPath}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(sealDoc(key.key, name, doc), null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, docPath)
}

/** PURE. The doc without its seal (what the parsers read). */
export function unsealed(text: string): string {
  try { const j = JSON.parse(text); if (isRec(j)) { delete j.integrity; return JSON.stringify(j) } } catch { /* the parser decides */ }
  return text
}
