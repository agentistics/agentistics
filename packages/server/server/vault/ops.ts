/**
 * vault/ops.ts — what the SERVICE does when another process asks over `vault.sock` (SECRETS.4 §5.2).
 *
 * The closed list of ops, and the rule each one is held to: NO op returns a human-scope plaintext.
 *
 *   status / lock / unlock      the vault's state; drop the key; give a passphrase vault its passphrase
 *   seal                        plaintext in (the body), the SEALED bytes out — for a CLI that has a
 *                               value the user just typed and must store it
 *   prefs-tokens                the preferences write's token half (prefs-tokens.ts), done here: the
 *                               sealed map is written and verified by the service; the reply is the
 *                               preferences object WITHOUT any token
 *   github-config               the GitHub-backup config with the token REMOVED (`hasToken` instead)
 *   github-fetch                one GitHub REST call to the CONFIGURED repository, the token added
 *                               here; the reply is GitHub's answer (never the token)
 *   central-mongo-kind          'none' | 'bundled' | 'external' — a fact derived from MONGO_URL, never
 *                               the URL (which can carry credentials)
 *   central-compose             `docker compose …` for a vaulted central, SPAWNED here with the sealed
 *                               env (the §5.2 stated exception: Docker needs the env, the CLI never
 *                               sees it); output streamed back
 *   central-native-tool         `agentop setup-token|reset-password` for a native central, spawned
 *                               here with its env, output streamed back
 *   central-env-write           the wizard's new central.env: secrets sealed (merged with the ones
 *                               already sealed) and verified here, the public half written
 *   vault-init / vault-rekey / vault-add-passphrase / vault-reset
 *                               the vault's own administration, run where the key is
 *
 * Every op validates its own inputs; an unknown op is `bad-request`. `ops.test.ts` runs each op with
 * a marker secret in the vault and asserts the marker appears in no reply and no reply body.
 */
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import {
  addPassphraseWrapper, destroyVault, initSentence, rekeyVault, scopeOfPurpose, type ProtectorId,
} from '@agentistics/vault'
import { AGENTISTICS_DATA_DIR } from '../config'
import {
  adoptCreated, chooseAutoProtector, createVault, ensureVaultOpen, lockVault, protectorById, protectorLabel,
  refused, runMigrations, sealBytes, sentence, unlockWithGesture, vaultAudit, vaultDir, vaultExists, vaultLang,
  vaultRole, vaultStatus, withSecret, noteVaultActivity,
} from './service'
import {
  addPassphraseAllowed, beginAuthenticator, beginRecoveryKey, completeUnlock, confirmAuthenticator, confirmRecoveryKey,
  disablePresence, enrolPresence, recoverWithWords, requirePresenceHere, requireVaultStepUp, setAutoLockMinutes, type GateContext, type VaultAction,
} from './gate'
import { readVaultView } from './inventory'
import { setVaultOpHandler, type OpContext, type OpResult } from './socket'
import { MAX_BODY } from './wire'
import { realProtectorIo } from './io'

type Reply = OpResult['reply']
const bad = (): OpResult => ({ reply: refused('bad-request', 'bad request') })
const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** Gate hook for S4.7 (`requireVaultStepUp` over the socket). Allows everything until installed. */
export type SocketGate = (action: string, header: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; code: string; sentence: string }>
let _gate: SocketGate = async () => ({ ok: true })
export function setSocketGate(g: SocketGate): void { _gate = g }

async function gated(action: string, h: Record<string, unknown>, run: () => Promise<OpResult>): Promise<OpResult> {
  const g = await _gate(action, h)
  if (!g.ok) return { reply: { ok: false, code: g.code, sentence: g.sentence } }
  return run()
}

// ── status / lock / unlock ───────────────────────────────────────────────────────────────────

async function opStatus(): Promise<OpResult> {
  return { reply: { ok: true, status: await vaultStatus() } }
}
async function opLock(h: Record<string, unknown>): Promise<OpResult> {
  // §2.4: a lock from a local TTY is never gated — reducing exposure must always work.
  return gated('lock-local', h, async () => { lockVault('user'); return { reply: { ok: true, status: await vaultStatus() } } })
}
/** §2.2 phase 1: raise the gesture (or use the passphrase / OS wrapper); may leave a code owed. */
async function opUnlock(h: Record<string, unknown>): Promise<OpResult> {
  if (h.passphrase !== undefined && !str(h.passphrase, 1024)) return bad()
  if (h.code !== undefined && !str(h.code, 16)) return bad()
  const u = await unlockWithGesture(typeof h.passphrase === 'string' ? h.passphrase : undefined)
  if (!u.ok) return { reply: { ok: false, code: u.code, sentence: u.sentence } }
  if (u.state === 'pending-stepup' && typeof h.code === 'string') return opUnlockCode(h)
  return { reply: { ok: true, unlock: u.state, status: await vaultStatus() } }
}
/** §2.2 phase 2: the authenticator code for the pending key. */
async function opUnlockCode(h: Record<string, unknown>): Promise<OpResult> {
  if (!str(h.code, 16)) return bad()
  const r = await completeUnlock(h.code)
  if (!r.ok) return { reply: r }
  return { reply: { ok: true, unlock: 'open', status: await vaultStatus() } }
}

// ── seal ────────────────────────────────────────────────────────────────────────────────────

async function opSeal(ctx: OpContext): Promise<OpResult> {
  const { purpose, name } = ctx.header
  if (!str(purpose, 128) || !str(name, 256) || !ctx.body) return bad()
  // Only the human scope's purposes; the runner scope has its own process path (§6.3).
  if (scopeOfPurpose(purpose) !== 'human') return { reply: refused('purpose', sentence('purpose')) }
  try {
    const sealed = await sealBytes(purpose, name, ctx.body)
    return { reply: { ok: true }, body: sealed }
  } catch (err) {
    const e = err as { code?: string; message?: string }
    return { reply: refused(e.code ?? 'locked', e.code ? e.message ?? sentence('locked') : sentence('locked')) }
  }
}

// ── preferences tokens ──────────────────────────────────────────────────────────────────────

/** A path the service will write a sealed map beside: the data directory and nothing else. */
function inDataDir(p: string): boolean {
  const abs = resolve(p)
  return abs === resolve(AGENTISTICS_DATA_DIR) || abs.startsWith(resolve(AGENTISTICS_DATA_DIR) + sep)
}

async function opPrefsTokens(h: Record<string, unknown>): Promise<OpResult> {
  const { prefsFile, next, previous } = h
  if (!str(prefsFile) || !inDataDir(prefsFile) || basename(prefsFile) !== 'preferences.json') return bad()
  if (!next || typeof next !== 'object' || Array.isArray(next)) return bad()
  if (previous !== null && (typeof previous !== 'object' || Array.isArray(previous))) return bad()
  const { stripAndSealTokens } = await import('./prefs-tokens')
  try {
    const stripped = await stripAndSealTokens(prefsFile, next as Record<string, unknown>, previous as Record<string, unknown> | null)
    return { reply: { ok: true, stripped } }
  } catch (err) {
    const e = err as { code?: string; message?: string }
    return { reply: refused(e.code ?? 'failed', e.message ?? 'the tokens could not be stored') }
  }
}

// ── GitHub backup ───────────────────────────────────────────────────────────────────────────

async function opGithubConfig(): Promise<OpResult> {
  const { readGithubConfigDetailed } = await import('../backup/github-store')
  const r = await readGithubConfigDetailed()
  if (r.state !== 'ok') return { reply: { ok: true, state: r.state, ...(r.state === 'refused' ? { sentence: r.sentence } : {}) } }
  const { token, ...rest } = r.config
  return { reply: { ok: true, state: 'ok', config: rest, hasToken: token !== '' } }
}

const GH_HEADERS_IN = new Set(['accept', 'content-type', 'x-github-api-version'])
const GH_HEADERS_OUT = ['content-type', 'link', 'location', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset']
const GH_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])

/** PURE. May the token be sent to `url`? Only the configured repository, on GitHub's own API hosts. */
export function githubUrlAllowed(url: string, owner: string, repo: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
  if (u.hostname !== 'api.github.com' && u.hostname !== 'uploads.github.com') return false
  const prefix = `/repos/${owner}/${repo}`
  return u.pathname === prefix || u.pathname.startsWith(prefix + '/')
}

async function opGithubFetch(ctx: OpContext, fetchImpl: typeof fetch = fetch): Promise<OpResult> {
  const { method, url, headers } = ctx.header
  if (!str(method, 8) || !GH_METHODS.has(method) || !str(url, 2048)) return bad()
  const { GITHUB_BACKUP_SEALED_FILE } = await import('../backup/github-store')
  // Per use: the config (token included) is opened for this one call and zeroed afterwards.
  const r = await withSecret('github-backup', 'github-backup', GITHUB_BACKUP_SEALED_FILE, async (plain) => {
    let cfg: { owner?: unknown; repo?: unknown; token?: unknown }
    try { cfg = JSON.parse(new TextDecoder().decode(plain)) } catch { return { reply: refused('tampered', sentence('tampered', { file: '~/.agentistics/github-backup.sealed' })) } as OpResult }
    if (typeof cfg.owner !== 'string' || typeof cfg.repo !== 'string' || typeof cfg.token !== 'string' || !cfg.token) {
      return { reply: refused('absent', 'no GitHub token is stored') } as OpResult
    }
    if (!githubUrlAllowed(url, cfg.owner, cfg.repo)) return { reply: refused('refused', 'the stored GitHub token is only used for the configured backup repository') } as OpResult
    const h: Record<string, string> = {}
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) if (GH_HEADERS_IN.has(k.toLowerCase()) && typeof v === 'string') h[k] = v
    }
    h.Authorization = `Bearer ${cfg.token}`
    let res: Response
    try {
      res = await fetchImpl(url, { method, headers: h, ...(ctx.body ? { body: ctx.body as unknown as BodyInit } : {}) })
    } catch {
      return { reply: refused('network', 'GitHub could not be reached') } as OpResult
    }
    const body = new Uint8Array(await res.arrayBuffer())
    if (body.length > MAX_BODY) return { reply: refused('too-large', 'GitHub answered with more than the vault socket carries') } as OpResult
    const outHeaders: Record<string, string> = {}
    for (const k of GH_HEADERS_OUT) { const v = res.headers.get(k); if (v !== null) outHeaders[k] = v }
    return { reply: { ok: true, httpStatus: res.status, headers: outHeaders }, body } as OpResult
  })
  if (r.ok) return r.value
  return { reply: r.absent ? refused('absent', 'no GitHub backup is configured') : refused(r.code ?? 'locked', r.sentence ?? sentence('locked')) }
}

// ── central ─────────────────────────────────────────────────────────────────────────────────

const STANDALONE_CENTRAL_DIR = join(homedir(), '.agentistics', 'central')

/** PURE-ish. A central env file this service will load sealed secrets for. */
async function vaultedEnv(envFile: unknown): Promise<string | null> {
  if (!str(envFile)) return null
  const { isVaultedEnvFile } = await import('./central-env')
  return isVaultedEnvFile(envFile) ? envFile : null
}

/** PURE. A compose file the service will run: the standalone dir's, or a checkout's docker/central*.yml. */
export function composeFileAllowed(f: string): boolean {
  const abs = resolve(f)
  if (dirname(abs) === resolve(STANDALONE_CENTRAL_DIR) && /^central(\.[a-z]+)*\.yml$/.test(basename(abs))) return true
  return /^central\.(image|localdb|selfcontrib)\.yml$/.test(basename(abs)) && basename(dirname(abs)) === 'docker'
    && existsSync(join(dirname(dirname(abs)), 'central.sh'))
}

const COMPOSE_EXEC = ['exec', '-T', 'app', 'bun', 'run', 'packages/server/bin/cli.ts']

/** PURE. The compose subcommands the service runs for a client. */
export function composeRestAllowed(rest: readonly string[]): boolean {
  const [cmd] = rest
  if (cmd === 'exec') {
    return COMPOSE_EXEC.every((a, i) => rest[i] === a) && (rest[COMPOSE_EXEC.length] === 'setup-token' || rest[COMPOSE_EXEC.length] === 'reset-password')
  }
  return ['up', 'ps', 'logs', 'down', 'restart', 'pull'].includes(cmd ?? '') && rest.every(a => /^[A-Za-z0-9=._-]{1,64}$/.test(a))
}

async function streamChild(ctx: OpContext, argv: string[], env: Record<string, string>): Promise<OpResult> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  } catch (err) {
    return { reply: refused('spawn-failed', `could not run ${basename(argv[0] ?? '')}: ${(err as Error)?.message ?? 'spawn failed'}`) }
  }
  void ctx.closed.then(() => { try { proc.kill() } catch { /* exited */ } })
  const pump = async (s: ReadableStream<Uint8Array> | null | undefined, which: 'out' | 'err') => {
    if (!s) return
    const dec = new TextDecoder()
    const reader = s.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) ctx.emit(which, dec.decode(value, { stream: true }))
      }
    } catch { /* the child went away mid-read */ }
  }
  await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, 'out'), pump(proc.stderr as ReadableStream<Uint8Array>, 'err')])
  return { reply: { ok: true, exit: await proc.exited } }
}

async function centralEnvOf(envFile: string): Promise<{ ok: true; env: Record<string, string> } | { ok: false; sentence: string }> {
  const { loadCentralSecrets } = await import('./central-env')
  return loadCentralSecrets(envFile)
}

async function opCentralMongoKind(h: Record<string, unknown>): Promise<OpResult> {
  const envFile = await vaultedEnv(h.envFile)
  if (!envFile) return bad()
  const s = await centralEnvOf(envFile)
  if (!s.ok) return { reply: refused('locked', s.sentence) }
  const url = s.env.MONGO_URL ?? ''
  const kind = url === '' ? 'none' : /(?:\/\/|@)mongo:\d+/.test(url) ? 'bundled' : 'external'
  return { reply: { ok: true, kind } }
}

async function opCentralCompose(ctx: OpContext): Promise<OpResult> {
  const h = ctx.header
  const envFile = await vaultedEnv(h.envFile)
  const files = h.composeFiles
  const rest = h.rest
  if (!envFile || !Array.isArray(files) || !files.every(f => typeof f === 'string' && composeFileAllowed(f))) return bad()
  if (!Array.isArray(rest) || !rest.every(a => typeof a === 'string') || !composeRestAllowed(rest as string[])) return bad()
  const image = typeof h.image === 'string' && /^[A-Za-z0-9./:@_-]{1,200}$/.test(h.image) ? h.image : null
  const project = typeof h.project === 'string' && /^[a-z0-9_-]{1,64}$/.test(h.project) ? h.project : 'team-mode'
  if (!image) return bad()
  const s = await centralEnvOf(envFile)
  if (!s.ok && rest[0] === 'up') return { reply: refused('locked', s.sentence) }
  const argv = ['docker', 'compose', '-p', project, '--env-file', envFile, ...(files as string[]).flatMap(f => ['-f', f]), ...(rest as string[])]
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(s.ok ? s.env : {}),
    AGENTISTICS_IMAGE: image,
    ...(h.streamed === true ? { NO_COLOR: '1', BUILDKIT_PROGRESS: 'plain' } : {}),
  }
  return streamChild(ctx, argv, env)
}

/** How THIS service re-invokes agentop (the compiled binary, or `bun cli.ts` from a checkout). */
function selfArgv(): string[] {
  const script = process.argv[1]
  return script && (script.endsWith('.ts') || script.endsWith('.js')) ? [process.execPath, script] : [process.execPath]
}

async function opCentralNativeTool(ctx: OpContext): Promise<OpResult> {
  const h = ctx.header
  const envFile = await vaultedEnv(h.envFile)
  if (!envFile || (h.action !== 'setup-token' && h.action !== 'reset-password')) return bad()
  const extra = Array.isArray(h.extraArgs) && h.extraArgs.every(a => typeof a === 'string' && a.length <= 512) ? h.extraArgs as string[] : null
  if (!extra) return bad()
  const { loadCentralEnv } = await import('./central-env')
  const { env, refusal } = await loadCentralEnv(envFile)
  if (refusal) return { reply: refused('locked', refusal) }
  return streamChild(ctx, [...selfArgv(), h.action, ...extra], { ...(process.env as Record<string, string>), ...env, AGENTISTICS_TEAM_CENTRAL: '1' })
}

async function opCentralEnvWrite(ctx: OpContext): Promise<OpResult> {
  const envFile = await vaultedEnv(ctx.header.envFile)
  if (!envFile || !ctx.body) return bad()
  // A vaulted central env lives under the data directory, by definition of isVaultedEnvFile.
  const text = new TextDecoder().decode(ctx.body)
  const { writeCentralEnv } = await import('./central-env')
  try {
    await writeCentralEnv(envFile, text)
    return { reply: { ok: true } }
  } catch (err) {
    const e = err as { code?: string; message?: string }
    return { reply: refused(e.code ?? 'failed', e.message ?? 'the central env could not be written') }
  }
}

// ── the vault's own administration ──────────────────────────────────────────────────────────

const ADMIN_PROTECTORS: ProtectorId[] = ['keychain', 'dpapi', 'libsecret', 'systemd-creds', 'passphrase']

async function opInit(h: Record<string, unknown>): Promise<OpResult> {
  const asked = h.protector
  if (asked !== undefined && !ADMIN_PROTECTORS.includes(asked as ProtectorId)) return bad()
  if (h.passphrase !== undefined && !str(h.passphrase, 1024)) return bad()
  if (vaultExists()) {
    const o = await ensureVaultOpen({ create: false, migrate: false })
    const r = o ? await runMigrations(true) : { migrated: 0, lines: [] }
    return { reply: { ok: true, existed: true, lines: r.lines, migrated: r.migrated, status: await vaultStatus() } }
  }
  const pass = typeof h.passphrase === 'string' ? h.passphrase : undefined
  let protector
  if (asked) {
    protector = protectorById(asked as ProtectorId, pass)
    if (!protector) return bad()
    if (asked === 'passphrase' && !pass) return { reply: refused('needs-passphrase', 'a passphrase is required') }
    const probe = await protector.probe()
    if (!probe.ok) return { reply: refused('probe-failed', `${asked} — ${probe.reason}`) }
  } else {
    const choice = await chooseAutoProtector()
    if (choice.ok) protector = choice.protector
    else if (choice.kind === 'unavailable') return { reply: refused('protector-unavailable', sentence('protector-unavailable', { protector: choice.protector.label(vaultLang()), reason: choice.reason })) }
    else if (!pass) return { reply: { ok: false, code: 'no-protector', sentence: sentence('no-protector', { checked: choice.checked.map(c => `${c.id} — ${c.reason}`).join('; ') }) } }
    else protector = protectorById('passphrase', pass)!
  }
  const made = await createVault(protector, pass)
  if (!made.ok) return { reply: refused('init-failed', made.reason) }
  adoptCreated(made.state)
  vaultAudit({ type: 'vault.init', protector: protector.id })
  const r = await runMigrations(true)
  return { reply: { ok: true, existed: false, said: initSentence(protector.label(vaultLang()), vaultLang()), lines: r.lines, migrated: r.migrated, status: await vaultStatus() } }
}

async function openOrRefuse(): Promise<{ ok: true; o: NonNullable<Awaited<ReturnType<typeof ensureVaultOpen>>> } | { ok: false; reply: Reply }> {
  const o = await ensureVaultOpen({ create: false, migrate: false })
  if (o) return { ok: true, o }
  const s = await vaultStatus()
  return { ok: false, reply: refused(s.state, s.sentence ?? sentence('locked')) }
}

async function opRekey(h: Record<string, unknown>): Promise<OpResult> {
  const id = h.protector as ProtectorId
  if (!ADMIN_PROTECTORS.includes(id)) return bad()
  if (h.passphrase !== undefined && !str(h.passphrase, 1024)) return bad()
  return gated('rekey', h, async () => {
    const r = await openOrRefuse()
    if (!r.ok) return { reply: r.reply }
    const pass = typeof h.passphrase === 'string' ? h.passphrase : undefined
    if (id === 'passphrase' && !pass) return { reply: refused('needs-passphrase', 'a passphrase is required') }
    const next = protectorById(id, pass)
    if (!next) return bad()
    const probe = await next.probe()
    if (!probe.ok) return { reply: refused('probe-failed', `${id} — ${probe.reason}`) }
    const old = r.o.vault.wrappers.map(w => protectorById(w.type)).filter((p): p is NonNullable<typeof p> => p !== null)
    const k = await rekeyVault(realProtectorIo(), vaultDir(), { state: 'open', ...r.o }, next, old)
    if (!k.ok) return { reply: refused('rekey-failed', k.reason) }
    r.o.vault = k.vault
    vaultAudit({ type: 'vault.rekey', protector: id })
    return { reply: { ok: true, protectorLabel: protectorLabel(id) } }
  })
}

async function opAddPassphrase(h: Record<string, unknown>): Promise<OpResult> {
  if (!str(h.passphrase, 1024)) return bad()
  return gated('add-passphrase', h, async () => {
    const r = await openOrRefuse()
    if (!r.ok) return { reply: r.reply }
    // §4.3: the recovery key replaces the recovery passphrase wherever a protector exists.
    const allowed = addPassphraseAllowed(r.o.vault)
    if (!allowed.ok) return { reply: allowed }
    const k = await addPassphraseWrapper(realProtectorIo(), vaultDir(), { state: 'open', ...r.o }, protectorById('passphrase', h.passphrase as string)!)
    if (!k.ok) return { reply: refused('add-passphrase-failed', k.reason) }
    r.o.vault = k.vault
    vaultAudit({ type: 'vault.add-passphrase' })
    return { reply: { ok: true } }
  })
}

async function opReset(h: Record<string, unknown>): Promise<OpResult> {
  return gated('reset', h, async () => {
    const s = await vaultStatus()
    const protectors = s.wrappers.map(w => protectorById(w)).filter((p): p is NonNullable<typeof p> => p !== null)
    lockVault()
    await destroyVault(realProtectorIo(), vaultDir(), protectors)
    vaultAudit({ type: 'vault.reset' })
    return { reply: { ok: true } }
  })
}

// ── SECRETS.4 §2 / §4 / §5.1 ─────────────────────────────────────────────────────────────────

const SOCKET: GateContext['session'] = 'socket'
const codeOf = (h: Record<string, unknown>) => (typeof h.code === 'string' && h.code.length <= 16 ? h.code : undefined)

async function opRecover(h: Record<string, unknown>): Promise<OpResult> {
  if (!str(h.words, 1024)) return bad()
  const r = await recoverWithWords(h.words)
  return { reply: r.ok ? { ok: true, todo: r.todo } : r }
}

/** Hands out a NEW seed's otpauth URI — once, by design: it must be scanned (§2.5). */
async function opAuthenticatorBegin(h: Record<string, unknown>): Promise<OpResult> {
  const label = typeof h.label === 'string' && /^[\w .@-]{1,64}$/.test(h.label) ? h.label : 'this machine'
  const r = await beginAuthenticator({ code: codeOf(h), session: SOCKET }, label)
  return { reply: r.ok ? { ok: true, uri: r.uri, secret: r.secret } : r }
}
async function opAuthenticatorConfirm(h: Record<string, unknown>): Promise<OpResult> {
  if (!str(h.code1, 16) || !str(h.code2, 16)) return bad()
  const r = await confirmAuthenticator(h.code1, h.code2)
  return { reply: r.ok ? { ok: true } : r }
}
/** Hands out the NEW 24 words — once, by design: they are written on paper (§4.2). */
async function opRecoveryBegin(h: Record<string, unknown>): Promise<OpResult> {
  const r = await beginRecoveryKey({ code: codeOf(h), session: SOCKET })
  return { reply: r.ok ? { ok: true, words: r.words, positions: r.positions } : r }
}
async function opRecoveryConfirm(h: Record<string, unknown>): Promise<OpResult> {
  if (!Array.isArray(h.typed) || h.typed.length !== 3 || !h.typed.every(w => str(w, 16))) return bad()
  const r = await confirmRecoveryKey(h.typed as string[])
  return { reply: r.ok ? { ok: true } : r }
}
async function opPresenceEnroll(h: Record<string, unknown>): Promise<OpResult> {
  if (h.protector !== 'hello' && h.protector !== 'fido2') return bad()
  const r = await enrolPresence(h.protector, { code: codeOf(h), session: SOCKET })
  return { reply: r.ok ? { ok: true, removed: r.removed } : r }
}
/** §7.4: the 24 words are typed on the TTY and arrive here only from the socket (never HTTP). */
async function opPresenceDisable(h: Record<string, unknown>): Promise<OpResult> {
  if (h.words !== undefined && !str(h.words, 1024)) return bad()
  const r = await disablePresence({ code: codeOf(h), session: SOCKET }, typeof h.words === 'string' ? h.words : undefined)
  return { reply: r.ok ? { ok: true, replacedBy: r.replacedBy } : r }
}
async function opRequirePresence(): Promise<OpResult> {
  const r = await requirePresenceHere()
  return { reply: r.ok ? { ok: true } : r }
}
/** The metadata the web's sections read (no inventory): authenticator, credentials, auto-lock, hardening. */
async function opView(): Promise<OpResult> {
  return { reply: { ok: true, view: await readVaultView([], async () => []) } }
}
async function opSetAutoLock(h: Record<string, unknown>): Promise<OpResult> {
  const r = await setAutoLockMinutes(h.minutes, { code: codeOf(h), session: SOCKET })
  return { reply: r.ok ? { ok: true } : r }
}

// ── dispatch ────────────────────────────────────────────────────────────────────────────────

export async function handleVaultOp(ctx: OpContext, deps: { fetch?: typeof fetch } = {}): Promise<OpResult> {
  // Only the holder answers; a client process that somehow listened would have no key to use.
  if (vaultRole() !== 'holder') return { reply: refused('service-only', sentence('service-only')) }
  const h = ctx.header
  // §5.1: any `agentop` verb is human interaction (a status poll is not).
  if (h.op !== 'status') noteVaultActivity()
  switch (h.op) {
    case 'status': return opStatus()
    case 'unlock-code': return opUnlockCode(h)
    case 'recover': return opRecover(h)
    case 'authenticator-begin': return opAuthenticatorBegin(h)
    case 'authenticator-confirm': return opAuthenticatorConfirm(h)
    case 'recovery-begin': return opRecoveryBegin(h)
    case 'recovery-confirm': return opRecoveryConfirm(h)
    case 'presence-enroll': return opPresenceEnroll(h)
    case 'presence-disable': return opPresenceDisable(h)
    case 'require-presence': return opRequirePresence()
    case 'view': return opView()
    case 'set-auto-lock': return opSetAutoLock(h)
    case 'activity': return { reply: { ok: true } }
    case 'lock': return opLock(h)
    case 'unlock': return opUnlock(h)
    case 'seal': return opSeal(ctx)
    case 'prefs-tokens': return opPrefsTokens(h)
    case 'github-config': return opGithubConfig()
    case 'github-fetch': return opGithubFetch(ctx, deps.fetch)
    case 'central-mongo-kind': return opCentralMongoKind(h)
    case 'central-compose': return opCentralCompose(ctx)
    case 'central-native-tool': return opCentralNativeTool(ctx)
    case 'central-env-write': return opCentralEnvWrite(ctx)
    case 'vault-init': return opInit(h)
    case 'vault-rekey': return opRekey(h)
    case 'vault-add-passphrase': return opAddPassphrase(h)
    case 'vault-reset': return opReset(h)
    default: return bad()
  }
}

/**
 * The closed list, for the tests that walk every op. Two ops hand a NEW secret to the caller ONCE, by
 * design, and never one the vault already held: `authenticator-begin` (the seed's otpauth URI, to be
 * scanned) and `recovery-begin` (the 24 words, to be written down).
 */
export const VAULT_OPS = [
  'status', 'lock', 'unlock', 'unlock-code', 'recover', 'authenticator-begin', 'authenticator-confirm',
  'recovery-begin', 'recovery-confirm', 'presence-enroll', 'set-auto-lock', 'activity', 'seal', 'prefs-tokens', 'github-config', 'github-fetch', 'central-mongo-kind',
  'central-compose', 'central-native-tool', 'central-env-write', 'vault-init', 'vault-rekey', 'vault-add-passphrase', 'vault-reset',
] as const

let _installed = false
export function installVaultOps(): void {
  if (_installed) return
  setVaultOpHandler(ctx => handleVaultOp(ctx))
  // The CLI proves the code with each gated op (no grants on the socket: a CLI call is one action).
  setSocketGate(async (action, h) => {
    const map: Record<string, VaultAction> = { 'lock-local': 'lock-local', rekey: 'rekey', 'add-passphrase': 'add-passphrase', reset: 'reset' }
    const a = map[action]
    if (!a) return { ok: false, code: 'bad-request', sentence: 'unknown vault action' }
    const g = await requireVaultStepUp(a, { code: codeOf(h), session: SOCKET })
    return g.ok ? { ok: true } : g
  })
  _installed = true
}
export function opsInstalled(): boolean { installVaultOps(); return _installed }

