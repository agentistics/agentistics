/**
 * delivery/guard-integrity.ts — the seal on `guards.json` and `guarantees.json` (ENTREGA.GARANTIDA S0d.2, QA F2).
 *
 * QA 13/11: both files were plain JSON, so a worker that edits `~/.agentistics/*.json` (§1.1) could delete
 * `guarantees.json` (every rule silently `off`), rewrite a rule to `on` with a forged owner log line, or plant a rank-5
 * checkpoint claiming a vault proof. Now each document carries `integrity: { v: 1, mac, gen }`,
 * `mac = HMAC-SHA256(key, "<document name>\0g<gen>\0" + canonical JSON of the document without integrity)` — the name binds
 * the MAC to ONE file, so one cannot be swapped for the other, and `gen` binds it to ONE generation of that file.
 *
 * THE KEY is `<dataDir>/guard-integrity.key` (0600, not a `.json`): 32 random bytes plus the list of documents ever sealed
 * with it, so a document that VANISHED is told apart from one that never existed. It is created by the first sealed
 * write and excluded from backups by the `.key` secret rule.
 *
 * S0d security re-QA (integration S0d+S1c):
 *   N1 — deleting files without reading the key must never read as a fresh machine. A SEALED WITNESS in its own directory
 *        (`<dataDir>/guard-seal/witness.json`, 0600) repeats which documents were sealed; a sealed sibling with no key
 *        proves a key existed; and the running process LATCHES every generation it verified. Any of the three makes an
 *        absent document `missing` / `key-missing` (fail closed, WARN) — never `fresh`.
 *   N2 — restoring an OLDER sealed copy is a rollback. Every sealed write bumps the document's generation, sealed inside
 *        its MAC, and records it in the witness (MAC'd with the same key); a document whose generation is below the
 *        witness's (or below what this process already saw) is `rolled-back`.
 *
 *   W1 — copying the three `.json` files (documents + witness) back from an older sealed copy and restarting: the KEY FILE
 *        also records the highest generation per document (line 4, `guards=3,guarantees=5`), written last on every sealed
 *        write. It is not a `.json`, is excluded from backups, and a backup restore does not carry it, so the copy-back reads
 *        `rolled-back`. Remaining limit: restoring the KEY FILE itself from the same old copy (four files) reverts every anchor.
 *
 * Stated limits (spec § S0d): a same-uid process that reads the key file can compute a MAC. Deleting (or rolling back)
 * the documents, the key AND the witness, in two directories, and then restarting the server reads a fresh machine; the
 * latch only covers the process that saw the newer state.
 *
 * PURE except the IO helpers at the bottom.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const GUARD_KEY_FILE = 'guard-integrity.key'
export const WITNESS_DIR = 'guard-seal'
export const WITNESS_FILE = 'witness.json'
const KEY_HEADER = 'agentistics-guard-integrity v1'
export type IntegrityDocName = 'guards' | 'guarantees'
const DOC_NAMES: readonly IntegrityDocName[] = ['guards', 'guarantees']
const DOC_FILES: Record<IntegrityDocName, string> = { guards: 'guards.json', guarantees: 'guarantees.json' }

export interface IntegrityKey {
  key: Buffer
  sealed: ReadonlySet<IntegrityDocName>
  /**
   * The highest generation sealed per document (W1). The key file is not a `.json`, is excluded from backups and sits outside
   * `guard-seal/`, so copying `guarantees.json` + `guards.json` + `witness.json` back from an older sealed copy cannot lower it.
   * Absent on a key file written before W1 (nothing to compare; the next sealed write starts recording).
   */
  gens?: Partial<Record<IntegrityDocName, number>>
}
export type TamperReason = 'unsealed' | 'forged' | 'missing' | 'key-missing' | 'key-unreadable' | 'rolled-back' | 'witness-missing' | 'witness-forged'
export type IntegrityVerdict = { state: 'ok'; gen?: number } | { state: 'fresh' } | { state: 'tampered'; reason: TamperReason }

/** The witness as read: `null` absent; `bad` unparseable or (with a key) a wrong MAC; else its facts and whether the MAC was checked. */
export type WitnessView = null | 'bad' | { sealed: ReadonlySet<IntegrityDocName>; gens: Partial<Record<IntegrityDocName, number>>; verified: boolean }

/** What else the verdict for ONE document may look at (N1/N2). All optional: absent = the pre-integration behaviour. */
export interface IntegrityContext {
  witness?: WitnessView
  /** The OTHER document of the pair is on disk carrying a seal (so a key existed). */
  siblingPresent?: boolean
  /** The highest generation of this document this process verified (the latch). */
  seenGen?: number
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** PURE. JSON with every object's keys sorted, so the MAC does not depend on property order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isRec(v)) return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/** PURE. The MAC of `doc` (its own `integrity` field ignored) as document `name` at generation `gen` (undefined = a v1 seal with no generation). */
export function docMac(key: Buffer, name: IntegrityDocName, doc: Record<string, unknown>, gen?: number): string {
  const { integrity: _i, ...body } = doc
  const head = gen === undefined ? `${name}\0` : `${name}\0g${gen}\0`
  return createHmac('sha256', key).update(`${head}${canonicalJson(body)}`).digest('base64url')
}

/** PURE. `doc` with its seal at generation `gen`. */
export function sealDoc<T extends object>(key: Buffer, name: IntegrityDocName, doc: T, gen = 1): T & { integrity: { v: 1; mac: string; gen: number } } {
  const { integrity: _i, ...body } = doc as Record<string, unknown>
  return { ...(body as T), integrity: { v: 1, mac: docMac(key, name, body, gen), gen } }
}

/** PURE. The witness MAC (same key; the label keeps it from ever verifying as a document). */
export function witnessMac(key: Buffer, sealed: Iterable<IntegrityDocName>, gens: Partial<Record<IntegrityDocName, number>>): string {
  const body = { sealed: [...new Set(sealed)].sort(), gens: Object.fromEntries(DOC_NAMES.filter(n => gens[n] !== undefined).map(n => [n, gens[n]])) }
  return createHmac('sha256', key).update(`witness\0${canonicalJson(body)}`).digest('base64url')
}

/** PURE. The witness file's text. */
export function formatWitness(key: Buffer, sealed: Iterable<IntegrityDocName>, gens: Partial<Record<IntegrityDocName, number>>): string {
  const s = [...new Set(sealed)].sort()
  return JSON.stringify({ v: 1, sealed: s, gens, mac: witnessMac(key, s, gens) }, null, 2) + '\n'
}

/** PURE. The witness, verified against `key` when there is one. */
export function parseWitness(text: string | null, key: IntegrityKey | null): WitnessView {
  if (text === null) return null
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return 'bad' }
  if (!isRec(raw) || raw.v !== 1 || !Array.isArray(raw.sealed) || !isRec(raw.gens) || typeof raw.mac !== 'string') return 'bad'
  const sealed = new Set<IntegrityDocName>()
  for (const n of raw.sealed) { if (!DOC_NAMES.includes(n as IntegrityDocName)) return 'bad'; sealed.add(n as IntegrityDocName) }
  const gens: Partial<Record<IntegrityDocName, number>> = {}
  for (const [k, v] of Object.entries(raw.gens)) {
    if (!DOC_NAMES.includes(k as IntegrityDocName) || !Number.isInteger(v) || (v as number) < 0) return 'bad'
    gens[k as IntegrityDocName] = v as number
  }
  if (!key) return { sealed, gens, verified: false }
  const want = Buffer.from(witnessMac(key.key, sealed, gens)), got = Buffer.from(raw.mac)
  return want.length === got.length && timingSafeEqual(want, got) ? { sealed, gens, verified: true } : 'bad'
}

/** PURE. Does this text claim a seal (an `integrity` object)? */
export function carriesSeal(text: string): boolean {
  try { const raw = JSON.parse(text) as unknown; return isRec(raw) && isRec(raw.integrity) } catch { return false }
}

/** PURE. The generation a document's seal names (0 for a v1 seal with none, or anything unreadable). */
export function docGen(text: string | null): number {
  if (text === null) return 0
  try {
    const raw = JSON.parse(text) as unknown
    return isRec(raw) && isRec(raw.integrity) && Number.isInteger(raw.integrity.gen) ? raw.integrity.gen as number : 0
  } catch { return 0 }
}

/**
 * PURE. What a document's bytes say, given the key (null = no key file) and the context (N1/N2).
 *   no text:  the key, the witness or the latch says it was sealed → missing (key-missing when the key is gone too);
 *             a sealed sibling with no key → key-missing (a key existed); else fresh.
 *   text:     no key → key-missing; no/garbled `integrity` (or not JSON) → unsealed; wrong MAC → forged;
 *             the witness absent / forged while the key says something was sealed → witness-missing / witness-forged;
 *             a generation below the witness's or the latch's → rolled-back.
 */
export function checkIntegrity(key: IntegrityKey | null, name: IntegrityDocName, text: string | null, ctx: IntegrityContext = {}): IntegrityVerdict {
  const w = ctx.witness
  if (text === null) {
    if (key?.sealed.has(name)) return { state: 'tampered', reason: 'missing' }
    const witnessSays = w === 'bad' || (!!w && w.sealed.has(name))
    if (witnessSays || ctx.seenGen !== undefined) return { state: 'tampered', reason: key ? 'missing' : 'key-missing' }
    if (!key && (ctx.siblingPresent || (!!w && w.sealed.size > 0))) return { state: 'tampered', reason: 'key-missing' }
    return { state: 'fresh' }
  }
  if (!key) return { state: 'tampered', reason: 'key-missing' }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { state: 'tampered', reason: 'unsealed' } }
  if (!isRec(raw) || !isRec(raw.integrity) || raw.integrity.v !== 1 || typeof raw.integrity.mac !== 'string') return { state: 'tampered', reason: 'unsealed' }
  const gen = raw.integrity.gen
  if (gen !== undefined && (!Number.isInteger(gen) || (gen as number) < 1)) return { state: 'tampered', reason: 'forged' }
  const want = Buffer.from(docMac(key.key, name, raw, gen as number | undefined)), got = Buffer.from(raw.integrity.mac)
  if (!(want.length === got.length && timingSafeEqual(want, got))) return { state: 'tampered', reason: 'forged' }
  const g = (gen as number | undefined) ?? 0
  if ('witness' in ctx) {
    if (w === 'bad') return { state: 'tampered', reason: 'witness-forged' }
    if (w === null && key.sealed.size > 0) return { state: 'tampered', reason: 'witness-missing' }
    if (w && g < (w.gens[name] ?? 0)) return { state: 'tampered', reason: 'rolled-back' }
  }
  if (ctx.seenGen !== undefined && g < ctx.seenGen) return { state: 'tampered', reason: 'rolled-back' }
  if (g < (key.gens?.[name] ?? 0)) return { state: 'tampered', reason: 'rolled-back' } // W1: the key file's own record
  return { state: 'ok', gen: g }
}

/** PURE. The key file's text. */
export function formatKeyFile(k: IntegrityKey): string {
  const gens = DOC_NAMES.filter(n => k.gens?.[n] !== undefined).map(n => `${n}=${k.gens![n]}`).join(',')
  return `${KEY_HEADER}\n${k.key.toString('base64')}\n${DOC_NAMES.filter(n => k.sealed.has(n)).join(',')}\n${gens}${gens ? '\n' : ''}`
}

/** PURE. `null` for anything that is not exactly a key file. */
export function parseKeyFile(text: string): IntegrityKey | null {
  const [head, b64, list = '', genLine = ''] = text.split('\n')
  if (head !== KEY_HEADER || !b64) return null
  const key = Buffer.from(b64, 'base64')
  if (key.length !== 32) return null
  const sealed = new Set<IntegrityDocName>()
  for (const n of list.split(',').filter(Boolean)) { if (!DOC_NAMES.includes(n as IntegrityDocName)) return null; sealed.add(n as IntegrityDocName) }
  const gens: Partial<Record<IntegrityDocName, number>> = {}
  for (const part of genLine.split(',').filter(Boolean)) {
    const [n, v] = part.split('=')
    const num = Number(v)
    if (!DOC_NAMES.includes(n as IntegrityDocName) || !Number.isInteger(num) || num < 0) return null
    gens[n as IntegrityDocName] = num
  }
  return Object.keys(gens).length ? { key, sealed, gens } : { key, sealed }
}

export const keyPathFor = (docPath: string): string => join(dirname(docPath), GUARD_KEY_FILE)
export const witnessPathFor = (docPath: string): string => join(dirname(docPath), WITNESS_DIR, WITNESS_FILE)
const siblingPathFor = (docPath: string, name: IntegrityDocName): string => join(dirname(docPath), DOC_FILES[name === 'guards' ? 'guarantees' : 'guards'])

/** The per-process latch: directory → document → highest generation verified or written here (N1/N2). */
const latch = new Map<string, Map<IntegrityDocName, number>>()
const seen = (docPath: string, name: IntegrityDocName): number | undefined => latch.get(dirname(docPath))?.get(name)
function remember(docPath: string, name: IntegrityDocName, gen: number): void {
  const m = latch.get(dirname(docPath)) ?? new Map<IntegrityDocName, number>()
  if ((m.get(name) ?? -1) < gen) m.set(name, gen)
  latch.set(dirname(docPath), m)
}
/** Test-only: forget what this process saw (as a restart would). */
export function __resetGuardLatchForTests(): void { latch.clear() }

/** IO. The key beside `docPath`: `null` when there is none; `'unreadable'` when a file is there and is not a key. */
export async function loadIntegrityKey(docPath: string): Promise<IntegrityKey | null | 'unreadable'> {
  let text: string
  try { text = await readFile(keyPathFor(docPath), 'utf8') } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'
  }
  return parseKeyFile(text) ?? 'unreadable'
}

async function readOrNull(path: string): Promise<string | null | 'unreadable'> {
  try { return await readFile(path, 'utf8') } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable' }
}

/** IO. The verdict for the document at `docPath` (its text, or null when absent). A verified document is latched. */
export async function verdictFor(docPath: string, name: IntegrityDocName, text: string | null): Promise<IntegrityVerdict> {
  const k = await loadIntegrityKey(docPath)
  if (k === 'unreadable') return { state: 'tampered', reason: 'key-unreadable' }
  const wText = await readOrNull(witnessPathFor(docPath))
  const witness: WitnessView = wText === 'unreadable' ? 'bad' : parseWitness(wText, k)
  // A sibling that carries a SEAL proves a key existed (an unsealed or garbled sibling proves nothing).
  const sib = await readOrNull(siblingPathFor(docPath, name))
  const siblingPresent = sib === 'unreadable' || (typeof sib === 'string' && carriesSeal(sib))
  const v = checkIntegrity(k, name, text, { witness, siblingPresent, seenGen: seen(docPath, name) })
  if (v.state === 'ok') remember(docPath, name, v.gen ?? 0)
  return v
}

async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, text, { mode: 0o600 })
  await rename(tmp, path)
}

/**
 * IO. Seal `doc` as `name` at the NEXT generation and write it atomically (0600). Order: the key (recording that `name` is
 * sealed), the witness (naming it sealed), the document, the witness again (its new generation). A crash at any step leaves
 * either "sealed but missing" (fail closed) or a document NEWER than the witness (accepted) — never a false clean.
 * Throws when the key file exists but is unreadable — nothing replaces it.
 */
export async function writeSealed(docPath: string, name: IntegrityDocName, doc: object): Promise<void> {
  await mkdir(dirname(docPath), { recursive: true })
  const found = await loadIntegrityKey(docPath)
  if (found === 'unreadable') throw new Error(`${GUARD_KEY_FILE} is unreadable; ${name}.json was not written`)
  let key = found
  if (!key || !key.sealed.has(name)) {
    key = { key: key?.key ?? randomBytes(32), sealed: new Set([...(key?.sealed ?? []), name]), ...(key?.gens ? { gens: key.gens } : {}) }
    await writePrivate(keyPathFor(docPath), formatKeyFile(key))
  }
  const wPath = witnessPathFor(docPath)
  const wText = await readOrNull(wPath)
  const prior = wText === 'unreadable' ? 'bad' : parseWitness(wText, key)
  // A forged/unreadable witness is REPLACED only by a writer allowed past the read (the owner's repair, or a clean store).
  const gens: Partial<Record<IntegrityDocName, number>> = prior && prior !== 'bad' ? { ...prior.gens } : {}
  const cur = await readOrNull(docPath)
  const gen = Math.max(gens[name] ?? 0, key.gens?.[name] ?? 0, seen(docPath, name) ?? 0, docGen(typeof cur === 'string' ? cur : null)) + 1
  await writePrivate(wPath, formatWitness(key.key, key.sealed, gens))
  await writePrivate(docPath, JSON.stringify(sealDoc(key.key, name, doc, gen), null, 2) + '\n')
  await writePrivate(wPath, formatWitness(key.key, key.sealed, { ...gens, [name]: gen }))
  // W1: the third anchor, written LAST (a crash before it leaves a document newer than the record, which is accepted).
  await writePrivate(keyPathFor(docPath), formatKeyFile({ ...key, gens: { ...key.gens, [name]: gen } }))
  remember(docPath, name, gen)
}

/** PURE. The doc without its seal (what the parsers read). */
export function unsealed(text: string): string {
  return text
}
