/**
 * tags-local-store.ts — file persistence for tags on a NON-central instance (solo / member).
 *
 * Tags used to exist only on a central, because the only store was Mongo (tags-store.ts). A solo
 * machine has repos and projects worth grouping too, so the same CRUD surface is provided here on
 * top of a single JSON file in the app's writable data dir:
 *
 *   ~/.agentistics/tags.json   → { version: 1, tags: TagDoc[] }
 *
 * Same document shape as the Mongo store, so tags-handlers can swap one for the other and the pure
 * modules (resolve/aggregate/detail/authority) never learn which one is behind them. That includes
 * the timestamps: a TagDoc carries real `Date`s IN MEMORY from either store. Here they cross a JSON
 * file, where a date can only be an ISO string — `JSON.stringify` writes one automatically and
 * `sanitize()` revives it on the way back in, so the Date-typed contract never becomes a lie.
 *
 * Durability rules this file follows:
 *  - writes go to `<file>.tmp` and are then renamed over the target, so a crash mid-write leaves
 *    either the old file or the new one — never a truncated one;
 *  - a missing, empty or corrupt file reads as an EMPTY store instead of throwing, so a mangled
 *    tags.json degrades to "no tags" rather than breaking the whole /api/tags route;
 *  - a corrupt file is NEVER overwritten in place: reading it empty and then writing would destroy
 *    whatever was still in there (the "create a tag, see an empty list, create another one" path).
 *    The original bytes are moved aside to `<file>.corrupt-<timestamp>` — and the path is logged —
 *    before the first write that follows a parse failure;
 *  - a mutation that changed nothing (update/delete of an unknown id) does not write at all;
 *  - every write is queued behind the previous one (one in-process writer), so two concurrent
 *    requests cannot interleave read-modify-write and lose a tag.
 */
import { randomBytes } from 'node:crypto'
import { rename, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from './config'
import type { TagSource, TagWindow } from './tags-resolve'

export interface TagDoc {
  _id: string
  name: string
  color?: string
  sources: TagSource[]
  filters?: TagSource[]
  window?: TagWindow
  sharedWith: string[]
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value !== 'string') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export const LOCAL_TAGS_FILE = join(AGENTISTICS_DATA_DIR, 'tags.json')

interface TagsFile {
  version: 1
  tags: TagDoc[]
}

/** The CRUD surface shared with tags-store.ts (the Mongo one). */
export interface TagStore {
  listAllTags(): Promise<TagDoc[]>
  getTag(id: string): Promise<TagDoc | null>
  createTag(input: {
    name: string; color?: string; sources: TagSource[]; filters?: TagSource[]; window?: TagWindow
    sharedWith: string[]; createdBy: string
  }): Promise<TagDoc>
  updateTag(id: string, patch: {
    name?: string; color?: string; sources?: TagSource[]; filters?: TagSource[]
    /** `null` clears the period; `undefined` leaves it alone. */
    window?: TagWindow | null; sharedWith?: string[]
  }): Promise<boolean>
  deleteTag(id: string): Promise<boolean>
  visibleTagsFor(canRead: (tag: TagDoc) => boolean): Promise<TagDoc[]>
}

/** Keep only the fields a TagDoc is made of, and only when they have the right shape. A hand-edited
 *  file is expected here, so anything unrecognisable is dropped rather than trusted. */
/** Keep only well-formed {type,value} entries. Shared by `sources` and `filters` so a hand-edited
 *  file cannot smuggle a malformed filter past the one and trip the other. */
function sanitizeSources(raw: unknown): TagSource[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is TagSource =>
    !!s && typeof s === 'object'
    && typeof (s as { type?: unknown }).type === 'string'
    && typeof (s as { value?: unknown }).value === 'string')
    .map(s => ({ type: s.type, value: s.value }))
}

/** A hand-edited file can hold anything; keep the period only when BOTH ends are well-formed and
 *  ordered, and drop it entirely otherwise. A half-parsed window would silently shift a tag's
 *  numbers, which is worse than the tag reverting to all-time. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
function sanitizeWindow(raw: unknown): TagWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const w = raw as Record<string, unknown>
  const start = typeof w.start === 'string' && DAY_RE.test(w.start) ? w.start : undefined
  const end = typeof w.end === 'string' && DAY_RE.test(w.end) ? w.end : undefined
  if (!start && !end) return undefined
  if (start && end && start > end) return undefined
  return { ...(start ? { start } : {}), ...(end ? { end } : {}) }
}

function sanitize(raw: unknown): TagDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (typeof d._id !== 'string' || !d._id) return null
  if (typeof d.name !== 'string' || !d.name) return null
  const sources = sanitizeSources(d.sources)
  const filters = sanitizeSources(d.filters)
  const window = sanitizeWindow(d.window)
  const now = new Date()
  return {
    _id: d._id,
    name: d.name,
    ...(typeof d.color === 'string' && d.color ? { color: d.color } : {}),
    sources,
    ...(filters.length ? { filters } : {}),
    ...(window ? { window } : {}),
    sharedWith: Array.isArray(d.sharedWith) ? d.sharedWith.filter((x): x is string => typeof x === 'string') : [],
    createdBy: typeof d.createdBy === 'string' ? d.createdBy : 'local',
    // Revive the ISO strings the file holds back into Dates. An absent or unparseable value
    // falls back to `now` rather than propagating a bogus timestamp.
    createdAt: toDate(d.createdAt) ?? now,
    updatedAt: toDate(d.updatedAt) ?? now,
  }
}

/**
 * Build a store bound to one file. The path is a parameter so tests can point it at a temp dir —
 * the filesystem is the thing under test here, so it is exercised for real, never mocked.
 */
export function createLocalTagStore(file: string): TagStore {
  // One in-process writer. Each write appends to this chain, so read-modify-write sequences run
  // strictly one after another even when several requests land at once.
  let queue: Promise<unknown> = Promise.resolve()
  // Set when a read failed to parse. The bad bytes are still on disk at that point; they are moved
  // aside (not overwritten) by the next write, so the "empty list" a corrupt file produces can never
  // become permanent data loss.
  let corrupt = false

  async function readAll(): Promise<TagDoc[]> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      corrupt = false
      return [] // absent (first run) — an empty store, not an error
    }
    if (!text.trim()) { corrupt = false; return [] }
    try {
      const parsed = JSON.parse(text) as Partial<TagsFile> | TagDoc[]
      const list = Array.isArray(parsed) ? parsed : (parsed.tags ?? [])
      if (!Array.isArray(list)) throw new Error('tags is not an array')
      corrupt = false
      return list.map(sanitize).filter((t): t is TagDoc => t !== null)
    } catch {
      // Corrupt/hand-mangled JSON. Starting empty keeps the route working, and the flag makes sure
      // the next write moves these bytes aside instead of erasing them.
      corrupt = true
      console.error('[tags] ignoring unreadable tag store at', file)
      return []
    }
  }

  /** Move a file that failed to parse out of the way, so the write that follows cannot destroy it.
   *  If the rename fails we ABORT the write and throw: the bytes we could not back up are the user's
   *  only copy of their tags, so failing the request is strictly better than erasing them. `corrupt`
   *  stays set, so a later write retries the quarantine instead of walking straight over the file. */
  async function quarantineCorrupt(): Promise<void> {
    if (!corrupt) return
    const backup = `${file}.corrupt-${Date.now()}`
    try {
      await rename(file, backup)
    } catch (err) {
      console.error('[tags] unreadable tag store at', file, 'could not be backed up — write aborted')
      throw new Error(`refusing to overwrite an unreadable tag store at ${file}: ${String(err)}`)
    }
    corrupt = false
    console.error('[tags] unreadable tag store moved aside; previous contents kept at', backup)
  }

  async function writeAll(tags: TagDoc[]): Promise<void> {
    await quarantineCorrupt()
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify({ version: 1, tags } satisfies TagsFile, null, 2))
    await rename(tmp, file)
  }

  /** Serialise a read-modify-write against the file. `changed: false` means the callback decided
   *  there was nothing to do (unknown id) — a no-op must not rewrite the file at all. */
  type Mutation<T> = { tags: TagDoc[]; result: T; changed?: boolean }
  function mutate<T>(fn: (tags: TagDoc[]) => Promise<Mutation<T>> | Mutation<T>): Promise<T> {
    const next = queue.then(async () => {
      const current = await readAll()
      const { tags, result, changed = true } = await fn(current)
      if (changed) await writeAll(tags)
      return result
    })
    // Keep the chain alive even if this step rejects, otherwise one failure poisons every later
    // write. The caller still sees the rejection through `next`.
    queue = next.catch(() => undefined)
    return next
  }

  const byName = (a: TagDoc, b: TagDoc) => a.name.localeCompare(b.name)
  // Named rather than reached through `this`, so the returned object survives being destructured.
  const listAllTags = async (): Promise<TagDoc[]> => (await readAll()).sort(byName)

  return {
    listAllTags,
    async getTag(id) {
      return (await readAll()).find(t => t._id === id) ?? null
    },
    async createTag(input) {
      const now = new Date()
      const doc: TagDoc = {
        _id: randomBytes(12).toString('hex'),
        name: input.name,
        ...(input.color ? { color: input.color } : {}),
        sources: input.sources,
        ...(input.filters && input.filters.length ? { filters: input.filters } : {}),
        ...(input.window ? { window: input.window } : {}),
        sharedWith: [...new Set(input.sharedWith.filter(Boolean))],
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      }
      return mutate(tags => ({ tags: [...tags, doc], result: doc }))
    },
    async updateTag(id, patch) {
      return mutate(tags => {
        const i = tags.findIndex(t => t._id === id)
        if (i < 0) return { tags, result: false, changed: false }
        const prev = tags[i]!
        // `window: undefined` in a spread still CREATES the key (value undefined), which survives
        // JSON.stringify as an absent key but not an in-memory `'window' in doc` check. Strip it
        // explicitly when clearing so the cleared doc is indistinguishable from one never set.
        const base = { ...prev }
        if (patch.window === null) delete base.window
        const next: TagDoc = {
          ...base,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.color !== undefined ? { color: patch.color } : {}),
          ...(patch.sources !== undefined ? { sources: patch.sources } : {}),
          ...(patch.filters !== undefined ? { filters: patch.filters } : {}),
          ...(patch.window ? { window: patch.window } : {}),
          ...(patch.sharedWith !== undefined ? { sharedWith: [...new Set(patch.sharedWith.filter(Boolean))] } : {}),
          updatedAt: new Date(),
        }
        const copy = [...tags]
        copy[i] = next
        return { tags: copy, result: true }
      })
    },
    async deleteTag(id) {
      return mutate(tags => {
        const kept = tags.filter(t => t._id !== id)
        const changed = kept.length !== tags.length
        return { tags: kept, result: changed, changed }
      })
    },
    async visibleTagsFor(canRead) {
      return (await listAllTags()).filter(canRead)
    },
  }
}

/** The process-wide store, bound to ~/.agentistics/tags.json. */
export const localTagStore: TagStore = createLocalTagStore(LOCAL_TAGS_FILE)
