/**
 * atomic.ts — the ONE way a private file is written, as an algorithm over `SecretFs`.
 *
 *   open(tmp, 'wx', 0600) in the same directory → write → fsync → close → rename →
 *   explicit chmod 0600 (its failure REPORTED, never swallowed) → fsync the directory.
 *
 * Expressed over an interface so the crash tests can stop it after any single syscall and restart:
 * a reader never sees a half-written file (rename is atomic), and a tmp file a crash leaves behind
 * holds exactly what was being written — which, for every caller here, is ALREADY SEALED bytes, never
 * plaintext. The vault's migration unlinks such strays.
 */

export interface SecretFsHandle {
  write(data: Uint8Array): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface SecretStat {
  mode: number
  size: number
  mtimeMs: number
}

export interface SecretFs {
  mkdirp(dir: string, mode: number): Promise<void>
  /** O_CREAT|O_EXCL|O_WRONLY with `mode`. */
  openExclusive(path: string, mode: number): Promise<SecretFsHandle>
  /** Open an EXISTING file for overwrite in place (the scrub). */
  openExisting(path: string): Promise<SecretFsHandle>
  rename(from: string, to: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  fsyncDir(dir: string): Promise<void>
  readFile(path: string): Promise<Uint8Array | null>
  unlink(path: string): Promise<void>
  lstat(path: string): Promise<SecretStat | null>
  readdir(dir: string): Promise<string[]>
  randomBytes(n: number): Uint8Array
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}
export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The tmp-file marker. A file `<target>.tmp-<hex>` beside a target is a crashed write of it. */
export const TMP_MARK = '.tmp-'

export interface AtomicWriteResult {
  /** Present when the explicit chmod failed — the caller says so; it is never silently dropped. */
  chmodFailed?: string
}

export async function writePrivateAtomic(fs: SecretFs, path: string, data: Uint8Array): Promise<AtomicWriteResult> {
  const dir = dirOf(path)
  await fs.mkdirp(dir, 0o700)
  const tmp = `${path}${TMP_MARK}${Buffer.from(fs.randomBytes(6)).toString('hex')}`
  const h = await fs.openExclusive(tmp, 0o600)
  try {
    await h.write(data)
    await h.sync()
  } finally {
    await h.close()
  }
  await fs.rename(tmp, path)
  let chmodFailed: string | undefined
  try {
    await fs.chmod(path, 0o600)
  } catch (err) {
    chmodFailed = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'chmod failed'
  }
  await fs.fsyncDir(dir)
  return chmodFailed ? { chmodFailed } : {}
}

/** The name a file is moved to before it is overwritten. Fixed, so a restart finds it. */
export const SCRUB_SUFFIX = '.scrub'

/**
 * Scrub a file: MOVE it aside (`<path>.scrub`, atomic), then overwrite it with random bytes of the
 * same length, fsync, unlink, fsync the directory.
 *
 * The move comes first for a reason the crash tests found: overwriting IN PLACE and crashing half
 * way leaves random bytes at the original path, and the next start would read them as a newer
 * secret and seal them over the real one. After the rename the original path is either the intact
 * plaintext or absent — never garbage — and a leftover `.scrub` file is finished by
 * `finishScrub` on the next pass.
 *
 * BEST-EFFORT by nature: on SSDs, copy-on-write filesystems, WSL's ext4-in-VHDX and anything with
 * snapshots the old blocks may survive. The guarantee is "nothing is written in plain text from now
 * on", never "the past is erased" — docs/security.md says so.
 */
export async function scrubFile(fs: SecretFs, path: string): Promise<void> {
  if (!(await fs.lstat(path))) return
  const aside = path + SCRUB_SUFFIX
  await fs.rename(path, aside)
  await fs.fsyncDir(dirOf(path))
  await finishScrub(fs, aside)
}

/** Overwrite + unlink a file already moved aside. Safe to repeat. */
export async function finishScrub(fs: SecretFs, aside: string): Promise<void> {
  const st = await fs.lstat(aside)
  if (!st) return
  if (st.size > 0) {
    const h = await fs.openExisting(aside)
    try {
      await h.write(fs.randomBytes(st.size))
      await h.sync()
    } finally {
      await h.close()
    }
  }
  await fs.unlink(aside)
  await fs.fsyncDir(dirOf(aside))
}

/** PURE. Is a mode open to group or others? A sealed file that is, is evidence something is wrong. */
export function isModeTooOpen(mode: number): boolean {
  return (mode & 0o077) !== 0
}
