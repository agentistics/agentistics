/**
 * cli-vault.ts — `agentop vault init|status|unlock|lock|enroll|recover|disable-presence|rekey|add-passphrase|reset`.
 *
 * The verbs over the machine's vault (docs/security.md § "Secrets at rest"). SECRETS.4 §5.2: every
 * verb is ASKED of the running service over `vault.sock`, which is the only process that holds the
 * key — `init`, `rekey` and `add-passphrase` included. A passphrase is typed here (never echoed) and
 * handed over on the socket; nothing the service answers carries a secret.
 *
 * There is deliberately NO verb that decrypts everything back to plain text: it would be a supported
 * path to the forbidden state. Leaving the vault is `reset` (which deletes it and every sealed file,
 * after a confirmation naming each) and re-entering the secrets.
 */
import { existsSync, rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
  checkPassphrase, destroyVault, migratedSentence, passphraseCheckSentence, refusalSentence,
  setupCodeCommand, setupCodeTtyRefusal, type ProtectorId,
} from '@agentistics/vault'
import { AGENTISTICS_DATA_DIR, DEFAULT_AGENTISTICS_DATA_DIR } from './config'
import { realProtectorIo } from './vault/io'
import {
  allRestoreWith, displayPath, pendingPlaintextFiles, protectorById, vaultDir, vaultExists, vaultLang, vaultStatus,
  type VaultStatus,
} from './vault/service'
import { askVault, askVaultSocket, type SocketReply } from './vault/socket'
import { loadVaultConsumers, pendingSecretValues, sealedFiles } from './vault/boot'
import { clearScreen, confirm, maskedInput, pause, select } from './cli-ui'
import { parseEnrolArgs, pickPresence, stepsToRun, wordGrid, type PresenceKind } from './vault/enroll-plan'
import { VAULT_PASSWORD_RULES, VAULT_PASSWORD_RULE_TEXT, checkVaultPassword, generateVaultPassword, vaultPasswordWeakSentence } from '@agentistics/core'

const HELP = `Usage: agentop vault <command>

  status [--json]          the vault's state, protector, sealed files and pending plaintext
  init [--protector <id>]  create the vault (the system protector; another only when named here)
  unlock                   give a locked service its passphrase (typed here, never echoed)
  lock                     drop the key from the running service
  rekey --protector <id>   move the vault to another protector (keychain|dpapi|libsecret|systemd-creds|passphrase)
  add-passphrase           add a passphrase wrapper beside the system one (how a Docker machine opens it)
  reset [--yes]            delete the vault and every sealed file — the secrets are then re-entered
  enroll                   protect the vault: how it confirms it is you, then the recovery key (what is still missing)
        [--recovery] [--presence touchid|hello|password|fido2] [--require-presence]
                           touchid  = Touch ID or the Mac password (macOS)
                           hello    = Windows Hello (Windows / WSL)
                           password = a vault password of your own (any system)
                           fido2    = a security key (advanced; only where libfido2 / webauthn is present)
  recover                  open the vault with your 24-word recovery key (terminal only)
  setup-code               print the one-time code the dashboard asks for its FIRST vault setup
  disable-presence         turn the confirmation off (it asks for it; the main machine also needs the 24 words)

There is no command that decrypts secrets back to plain text.`

function t(en: string, pt: string): string {
  return vaultLang() === 'pt' ? pt : en
}

/** The slice of `GET /api/vault` the §7.2 status adds (`view` op): never a secret, never a value. */
interface View {
  presence?: boolean; presenceAvailable?: string[]; requirePresence?: boolean; recoveryCreatedAt?: string | null
  /** COFRE.DESBLOQUEIO: the ways this machine offers, and the one(s) the vault confirms with. */
  unlockMethods?: { id: string; advanced: boolean }[]; methods?: string[]; legacyAppCode?: boolean
  autoLockMinutes?: number; autoLockInMs?: number | null; pendingStepup?: boolean
  recoveryTodo?: string[] | null
  hardening?: { state: string; private: boolean | null; coreDumps: string | null; yama: string | null; lines: string[] } | null
}

/** A way of confirming, in the user's words. */
function methodName(id: string): string {
  switch (id) {
    case 'touchid': return t('Touch ID or the Mac password', 'Touch ID ou senha do Mac')
    case 'hello': return 'Windows Hello'
    case 'password': return t('vault password', 'senha do cofre')
    case 'fido2': return t('security key', 'chave de segurança')
    default: return id
  }
}

function minutesWords(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / 60_000))
  return t(`${m} min`, `${m} min`)
}

function printSecurity(v: View, wrappers: string[]): void {
  const out = (k: string, val: string) => process.stdout.write(`${k}: ${val}\n`)
  out(t('scope', 'escopo'), t('human', 'humano'))
  const pres = v.methods ?? wrappers.filter(w => ['touchid', 'hello', 'password', 'fido2'].includes(w))
  const offers = (v.unlockMethods ?? []).map(m => m.advanced ? `${methodName(m.id)} (${t('advanced', 'avançado')})` : methodName(m.id))
  out(t('confirms with', 'confirma com'), pres.length
    ? `${pres.map(methodName).join(', ')}${v.requirePresence ? t(' (main machine: required)', ' (máquina principal: obrigatória)') : ''}`
    : t('nothing chosen yet — run `agentop vault enroll`', 'nada escolhido ainda — rode `agentop vault enroll`'))
  if (offers.length) out(t('this machine offers', 'esta máquina oferece'), offers.join(', '))
  out(t('recovery key', 'chave de recuperação'), v.recoveryCreatedAt ? `${t('created', 'criada em')} ${v.recoveryCreatedAt}` : t('not created', 'não criada'))
  out(t('auto-lock', 'bloqueio automático'), `${v.autoLockMinutes ?? 30} min${typeof v.autoLockInMs === 'number' ? t(` — locks in ${minutesWords(v.autoLockInMs)}`, ` — trava em ${minutesWords(v.autoLockInMs)}`) : ''}`)
  if (v.recoveryTodo?.length) out(t('recovery mode', 'modo de recuperação'), t(`still owed: ${v.recoveryTodo.join(', ')} — run \`agentop vault enroll\``, `falta: ${v.recoveryTodo.join(', ')} — rode \`agentop vault enroll\``))
  const h = v.hardening
  if (h) {
    const bits = [h.private === null ? null : (h.private ? t('non-dumpable ✓', 'não-despejável ✓') : t('NOT private ✗', 'NÃO privada ✗')), h.coreDumps ? (h.coreDumps === 'off' ? t('core dumps off ✓', 'core dumps desligados ✓') : t('core dumps ON ✗', 'core dumps LIGADOS ✗')) : null].filter(Boolean)
    out(t('hardening', 'endurecimento'), bits.length ? bits.join(' · ') : h.state)
    for (const l of h.lines) process.stdout.write(`  ${l}\n`)
  }
}

function printStatus(s: VaultStatus, sealed: string[], pendingFiles: string[]): void {
  const state = {
    open: t('open', 'aberto'), locked: t('locked', 'trancado'), uninitialized: t('not created', 'não criado'),
    'protector-lost': t('protector lost', 'protetor perdido'), corrupt: t('unreadable', 'ilegível'),
  }[s.state]
  process.stdout.write(`${t('vault', 'cofre')}: ${state}\n`)
  if (s.protectorLabel) process.stdout.write(`${t('protector', 'protetor')}: ${s.protectorLabel}\n`)
  if (s.wrappers.length > 1) process.stdout.write(`${t('wrappers', 'invólucros')}: ${s.wrappers.join(', ')}\n`)
  if (s.kid) process.stdout.write(`${t('key id', 'id da chave')}: ${s.kid}\n`)
  process.stdout.write(`${t('sealed files', 'arquivos selados')}: ${sealed.length}\n`)
  for (const f of sealed) process.stdout.write(`  ${displayPath(f)}\n`)
  process.stdout.write(`${t('plaintext waiting for migration', 'texto puro aguardando migração')}: ${s.pending}\n`)
  for (const f of pendingFiles) process.stdout.write(`  ${displayPath(f)}\n`)
  if (s.sentence) process.stdout.write(`\n${s.sentence}\n`)
}

async function askPassphrase(confirmIt: boolean): Promise<string | null> {
  if (!process.stdin.isTTY) {
    process.stderr.write(t('A passphrase can only be typed on a terminal.\n', 'A frase-senha só pode ser digitada em um terminal.\n'))
    return null
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = await maskedInput(t('Vault passphrase', 'Frase-senha do cofre'))
    const check = checkPassphrase(p, pendingSecretValues())
    if (!check.ok) { process.stderr.write(passphraseCheckSentence(check.reason, vaultLang()) + '\n'); continue }
    if (confirmIt) {
      const again = await maskedInput(t('Type it again', 'Digite de novo'))
      if (again !== p) { process.stderr.write(t('The two did not match.\n', 'As duas não conferem.\n')); continue }
    }
    return p
  }
  return null
}

/**
 * SECRETS.4 §5.2: every verb goes through the running service over `vault.sock`. This process never
 * opens the vault — no data key in a CLI, not even for one command. With no service, the verb says so
 * (`service-down`) instead of opening it here; only `status` (which reads no secret) and `reset`
 * (which deletes, and needs no key) still work without one.
 */
async function ask(req: Parameters<typeof askVault>[0], opts: { body?: Uint8Array; timeoutMs?: number } = {}): Promise<SocketReply | null> {
  // 3 min by default: a gated verb may raise a presence gesture in the service, and a person answers it.
  const r = await askVault(req, { timeoutMs: opts.timeoutMs ?? 180_000, ...(opts.body ? { body: opts.body } : {}) })
  return r ? r.reply : null
}

function down(): number {
  process.stderr.write(refusalSentence('service-down', vaultLang()) + '\n')
  return 1
}

/** The vault password, typed on the TTY (never echoed, never on argv). */
async function askVaultPassword(): Promise<string | null> {
  if (!process.stdin.isTTY) { process.stderr.write(t('The vault password can only be typed on a terminal.\n', 'A senha do cofre só pode ser digitada em um terminal.\n')); return null }
  const p = await maskedInput(t('Vault password', 'Senha do cofre'))
  return p || null
}

/**
 * Ask a gated op; when the service says the vault PASSWORD is needed (COFRE.DESBLOQUEIO — a vault that
 * confirms with its own password), ask for it on the TTY and ask again. A gesture (Touch ID, Windows
 * Hello, a key) is raised by the service itself and needs nothing here.
 */
async function askGated(req: Record<string, unknown> & { op: string }): Promise<SocketReply | null> {
  let r = await ask(req)
  for (let i = 0; r && !r.ok && (r.code === 'password-required' || r.code === 'password-wrong') && i < 3; i++) {
    if (r.code !== 'password-required') process.stderr.write(String(r.sentence) + '\n')
    const password = await askVaultPassword()
    if (!password) return r
    r = await ask({ ...req, password })
  }
  return r
}

function said(r: SocketReply): number {
  if (r.ok) return 0
  process.stderr.write(String(r.sentence) + '\n')
  return 1
}

async function readView(): Promise<View | null> {
  const r = await askVaultSocket({ op: 'view' })
  return r && r.ok && r.view && typeof r.view === 'object' ? r.view as View : null
}

async function cmdStatus(json: boolean): Promise<number> {
  const viaService = await askVaultSocket({ op: 'status' })
  const s = viaService && viaService.ok && viaService.status ? viaService.status : await vaultStatus()
  const sealed = sealedFiles()
  const pendingFiles = await pendingPlaintextFiles()
  const view = viaService ? await readView() : null
  if (json) {
    process.stdout.write(JSON.stringify({ ...s, ...(view ? { security: view } : {}), sealedFiles: sealed.map(displayPath), pendingFiles: pendingFiles.map(displayPath), service: Boolean(viaService) }, null, 2) + '\n')
  } else {
    printStatus(s, sealed, pendingFiles)
    if (view) printSecurity(view, s.wrappers)
    if (!viaService && vaultExists()) process.stdout.write('\n' + refusalSentence('service-down', vaultLang()) + '\n')
  }
  return 0
}

const PROTECTOR_IDS: ProtectorId[] = ['keychain', 'dpapi', 'libsecret', 'systemd-creds', 'passphrase']

function report(r: Record<string, unknown>): void {
  for (const l of Array.isArray(r.lines) ? r.lines : []) process.stdout.write(String(l) + '\n')
  const n = typeof r.migrated === 'number' ? r.migrated : 0
  if (n > 0) process.stdout.write(migratedSentence(n, allRestoreWith(), vaultLang()) + '\n')
}

async function cmdInit(args: string[]): Promise<number> {
  const i = args.indexOf('--protector')
  const asked = i !== -1 ? args[i + 1] as ProtectorId | undefined : undefined
  if (i !== -1 && (!asked || !PROTECTOR_IDS.includes(asked))) {
    process.stderr.write(`usage: agentop vault init [--protector ${PROTECTOR_IDS.join('|')}]\n`)
    return 2
  }
  let pass: string | undefined
  if (asked === 'passphrase') {
    const p = await askPassphrase(true)
    if (!p) return 1
    pass = p
  }
  let r = await ask({ op: 'vault-init', ...(asked ? { protector: asked } : {}), ...(pass ? { passphrase: pass } : {}) })
  if (!r) return down()
  if (!r.ok && r.code === 'no-protector') {
    // No system keychain answered in the service: the passphrase is typed HERE and handed over.
    process.stdout.write(String(r.sentence) + '\n\n')
    const p = await askPassphrase(true)
    if (!p) return 1
    r = await ask({ op: 'vault-init', passphrase: p })
    if (!r) return down()
  }
  if (!r.ok) return said(r)
  if (r.existed) process.stdout.write(t('This machine already has a vault.\n\n', 'Esta máquina já tem um cofre.\n\n'))
  else if (typeof r.said === 'string') process.stdout.write(r.said + '\n')
  report(r)
  return r.existed ? cmdStatus(false) : 0
}

async function cmdUnlock(): Promise<number> {
  const st = await askVaultSocket({ op: 'status' })
  if (!st) return down()
  if (st.ok && st.status?.state === 'open') { process.stdout.write(t('The vault is already open in the agentop service.\n', 'O cofre já está aberto no serviço do agentop.\n')); return 0 }
  const needsPass = st.ok && (st.status?.wrappers ?? []).includes('passphrase') && st.status?.state === 'locked'
  const pass = needsPass ? await askPassphrase(false) : undefined
  if (needsPass && !pass) return 1
  const wrappers = st.ok ? (st.status?.wrappers ?? []) : []
  // COFRE.DESBLOQUEIO: a vault that confirms with its own password asks for it HERE; the SERVICE raises
  // a gesture (Touch ID / the Mac password, Windows Hello, a key) itself.
  const password = wrappers.includes('password') && !wrappers.some(w => w === 'touchid' || w === 'hello' || w === 'fido2') ? await askVaultPassword() : null
  if (wrappers.includes('password') && !wrappers.some(w => w === 'touchid' || w === 'hello' || w === 'fido2') && !password) return 1
  if (wrappers.some(w => w === 'touchid' || w === 'hello' || w === 'fido2')) {
    process.stdout.write(t('Confirm on the prompt the service is raising (Touch ID / the Mac password, Windows Hello or your key)…\n', 'Confirme no pedido que o serviço está abrindo (Touch ID / senha do Mac, Windows Hello ou a sua chave)…\n'))
  }
  const svc = await askGated({ op: 'unlock', ...(pass ? { passphrase: pass } : {}), ...(password ? { password } : {}) })
  if (!svc) return down()
  if (!svc.ok) return said(svc)
  process.stdout.write(t('The agentop service unlocked its vault.\n', 'O serviço do agentop destrancou o cofre.\n'))
  return 0
}

async function cmdLock(): Promise<number> {
  const svc = await askVaultSocket({ op: 'lock' })
  if (!svc) { process.stdout.write(t('No agentop service is running — nothing holds the key.\n', 'Nenhum serviço do agentop está rodando — nada guarda a chave.\n')); return 0 }
  if (!svc.ok) return said(svc)
  process.stdout.write(t('The agentop service dropped the vault key.\n', 'O serviço do agentop descartou a chave do cofre.\n'))
  return 0
}

async function cmdRekey(args: string[]): Promise<number> {
  const i = args.indexOf('--protector')
  const id = (i !== -1 ? args[i + 1] : undefined) as ProtectorId | undefined
  if (!id || !PROTECTOR_IDS.includes(id)) {
    process.stderr.write('usage: agentop vault rekey --protector keychain|dpapi|libsecret|systemd-creds|passphrase\n')
    return 2
  }
  if (!(await askVaultSocket({ op: 'status' }))) return down()
  const pass = id === 'passphrase' ? await askPassphrase(true) : undefined
  if (id === 'passphrase' && !pass) return 1
  const r = await askGated({ op: 'vault-rekey', protector: id, ...(pass ? { passphrase: pass } : {}) })
  if (!r) return down()
  if (!r.ok) return said(r)
  process.stdout.write(t(`The vault key is now kept by ${String(r.protectorLabel ?? id)}.\n`, `A chave do cofre agora é guardada por ${String(r.protectorLabel ?? id)}.\n`))
  return 0
}

async function cmdAddPassphrase(): Promise<number> {
  if (!(await askVaultSocket({ op: 'status' }))) return down()
  process.stdout.write(t(
    'A passphrase wrapper is an OFFLINE brute-force target beside the files it opens: choose a long one.\n',
    'Um invólucro de frase-senha é um alvo de força bruta OFFLINE ao lado dos arquivos que ele abre: escolha uma longa.\n'))
  const pass = await askPassphrase(true)
  if (!pass) return 1
  const r = await askGated({ op: 'vault-add-passphrase', passphrase: pass })
  if (!r) return down()
  if (!r.ok) return said(r)
  process.stdout.write(t('Added. A container mounting ~/.agentistics opens this vault with `agentop vault unlock`.\n',
    'Adicionado. Um contêiner que monta ~/.agentistics abre este cofre com `agentop vault unlock`.\n'))
  return 0
}

async function cmdReset(args: string[]): Promise<number> {
  const files = sealedFiles()
  if (!vaultExists() && files.length === 0) { process.stdout.write(t('There is no vault to reset.\n', 'Não há cofre para redefinir.\n')); return 0 }
  process.stdout.write(t('This deletes the vault and every sealed secret on this machine:\n', 'Isto apaga o cofre e todo segredo selado nesta máquina:\n'))
  process.stdout.write(`  ${displayPath(vaultDir())}/\n`)
  for (const f of files) process.stdout.write(`  ${displayPath(f)}\n`)
  process.stdout.write(t(`They cannot be recovered. Re-enter them afterwards with: ${allRestoreWith()}\n`, `Eles não podem ser recuperados. Cadastre-os de novo depois com: ${allRestoreWith()}\n`))
  process.stdout.write(t(
    'Provider keys (~/.agentistics/provider-keys) belong to the engine and are not touched here; the ones sealed with this vault no longer open — re-enter them with `agentop provider key set <provider>`. Keys sealed to the machine (provider-keys/machine) do not depend on this vault.\n',
    'As chaves de provedor (~/.agentistics/provider-keys) pertencem ao motor e não são tocadas aqui; as seladas com este cofre não abrem mais — cadastre-as de novo com `agentop provider key set <provider>`. As seladas à máquina (provider-keys/machine) não dependem deste cofre.\n'))
  if (!args.includes('--yes')) {
    if (!process.stdin.isTTY) { process.stderr.write(t('Refusing without a terminal; pass --yes.\n', 'Recusado sem terminal; passe --yes.\n')); return 1 }
    if (!(await confirm(t('Delete them?', 'Apagar?'), false))) return 1
  }
  const svc = await askGated({ op: 'vault-reset' })
  if (svc && !svc.ok) return said(svc)
  if (!svc) {
    // No service holds the key: deleting the wrapped keys needs no key at all, so it is done here.
    const s = await vaultStatus()
    const protectors = s.wrappers.map(w => protectorById(w)).filter((p): p is NonNullable<typeof p> => p !== null)
    await destroyVault(realProtectorIo(), vaultDir(), protectors)
  }
  for (const f of files) rmSync(f, { force: true })
  if (existsSync(vaultDir())) rmSync(vaultDir(), { recursive: true, force: true })
  process.stdout.write(t('The vault and its sealed secrets were deleted.\n', 'O cofre e os segredos selados foram apagados.\n'))
  return 0
}

/**
 * §4.3 `agentop vault recover` — TTY ONLY: the 24 words are typed here (never echoed, never on argv,
 * never in a web form) and handed to the service, which opens the vault in RECOVERY mode. Then the
 * two steps are owed: presence, then a NEW recovery key (the old words were just typed).
 */
/** Review S2: the one-time code a page needs to start the FIRST enrolment — shown here, on this machine. */
async function cmdSetupCode(): Promise<number> {
  // Shown on a terminal only: never into a pipe, a file or a log (leader decision 3).
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // The TTY rule stands; the refusal says WHERE a real terminal is (an assistant's `!` is not one).
    process.stderr.write(setupCodeTtyRefusal(vaultLang(), setupCodeCommand(AGENTISTICS_DATA_DIR, DEFAULT_AGENTISTICS_DATA_DIR)) + '\n')
    return 1
  }
  const r = await ask({ op: 'setup-code', tty: true })
  if (!r) return down()
  if (!r.ok || typeof r.code !== 'string') return said(r)
  const mins = Math.max(1, Math.ceil(Number(r.expiresInMs ?? 0) / 60_000))
  process.stdout.write(t(
    `Setup code: ${r.code.slice(0, 4)} ${r.code.slice(4)}\nType it on the Vault page (Unlock methods). It works once, for ${mins} minutes.\n`,
    `Código de configuração: ${r.code.slice(0, 4)} ${r.code.slice(4)}\nDigite-o na página Cofre (Métodos de desbloqueio). Vale uma vez, por ${mins} minutos.\n`))
  return 0
}

async function cmdRecover(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(t('The recovery key is typed only on a terminal.\n', 'A chave de recuperação só é digitada em um terminal.\n'))
    return 1
  }
  if (!(await askVaultSocket({ op: 'status' }))) return down()
  const words = await maskedInput(t('Your 24 words (spaces between them; 4 letters each is enough)', 'Suas 24 palavras (com espaços; 4 letras de cada bastam)'))
  const r = await ask({ op: 'recover', words })
  if (!r) return down()
  if (!r.ok) return said(r)
  const todo = Array.isArray(r.todo) ? (r.todo as string[]) : []
  process.stdout.write(t(
    `The vault is open in recovery mode. Before anything else: ${todo.join(', ')} — run \`agentop vault enroll\`. Your old 24 words will stop working when you receive the new ones.\n`,
    `O cofre está aberto em modo de recuperação. Antes de qualquer outra coisa: ${todo.join(', ')} — rode \`agentop vault enroll\`. Suas 24 palavras antigas deixam de funcionar quando você receber as novas.\n`))
  return 0
}

/**
 * §7.3 `agentop vault enroll` — TTY ONLY (24 words are for a person looking at a screen).
 * Runs what is still missing, in the one safe order: the recovery key
 * (shown once, three words typed back), then presence, which is the step that retires the silent OS
 * wrapper — written and read back before the old one goes, so a crash anywhere leaves the vault
 * openable. Every step is a request to the SERVICE; this process never holds a key or a seed.
 */
async function cmdEnroll(args: string[]): Promise<number> {
  const parsed = parseEnrolArgs(args)
  if (!parsed.ok) {
    process.stderr.write((parsed.retired === 'authenticator'
      ? t('The vault no longer uses an app code. Choose how it confirms it is you: --presence touchid|hello|password|fido2.\n',
        'O cofre não usa mais código de aplicativo. Escolha como ele confirma que é você: --presence touchid|hello|password|fido2.\n')
      : '') + parsed.usage + '\n')
    return 2
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(t('Enrolment needs a terminal: it shows 24 words that are never written anywhere else.\n',
      'A configuração precisa de um terminal: ela mostra 24 palavras que não são gravadas em nenhum outro lugar.\n'))
    return 1
  }
  if (!(await askVaultSocket({ op: 'status' }))) return down()
  if (parsed.value.requirePresence) {
    const m = await ask({ op: 'require-presence' })
    if (!m) return down()
    if (!m.ok) return said(m)
    process.stdout.write(t('This is now the main machine: presence cannot be turned off without the recovery key.\n\n', 'Esta agora é a máquina principal: a presença só pode ser desligada com a chave de recuperação.\n\n'))
  }
  let view = await readView()
  if (!view) return down()
  const state = () => ({ recovery: Boolean(view?.recoveryCreatedAt), presence: Boolean(view?.presence), available: view?.unlockMethods ?? [] })
  const steps = stepsToRun(parsed.value, state())
  if (steps.length === 0) {
    process.stdout.write(t('Nothing left to set up: the vault confirms it is you and has its recovery key.\n', 'Nada a configurar: o cofre já confirma que é você e tem a chave de recuperação.\n'))
    return cmdStatus(false)
  }
  let presence = pickPresence(parsed.value.presence, state().available)
  if (steps.includes('presence') && parsed.value.presence && !presence) {
    process.stderr.write(t(`${methodName(parsed.value.presence)} is not offered on this machine. It offers: ${state().available.map(m => methodName(m.id)).join(', ')}.\n`,
      `${methodName(parsed.value.presence)} não é oferecido nesta máquina. Ela oferece: ${state().available.map(m => methodName(m.id)).join(', ')}.\n`))
    return 1
  }
  if (steps.includes('presence') && !parsed.value.presence) {
    // No flag: ASK which way, from what this machine offers (the vault password is always one of them).
    const offers = state().available
    const chosen = await select<string>({
      message: t('How should the vault confirm it is you?', 'Como o cofre deve confirmar que é você?'),
      choices: offers.map(m => ({ name: methodName(m.id), value: m.id, ...(m.advanced ? { hint: t('advanced', 'avançado') } : {}) })),
    })
    presence = chosen as typeof presence
  }
  for (const step of steps) {
    const rc = step === 'recovery' ? await enrolRecovery() : await enrolPresence(presence!, steps.includes('recovery'))
    if (rc !== 0) return rc
  }
  view = await readView()
  if (steps.includes('presence') && view?.presence) {
    const pres = (view.methods ?? []).map(methodName).join(t(' or ', ' ou ')) || methodName(presence ?? '')
    process.stdout.write('\n' + t(
      `Done. From now on the vault opens only with ${pres}. It locks itself after ${view?.autoLockMinutes ?? 30} minutes without use. Keep your 24 words offline.\n`,
      `Pronto. A partir de agora o cofre só abre com ${pres}. Ele trava sozinho depois de ${view?.autoLockMinutes ?? 30} minutos sem uso. Guarde as suas 24 palavras offline.\n`))
  }
  return 0
}

/**
 * The vault password, chosen on the terminal: the rules are checked HERE as it is typed (the same
 * `checkVaultPassword` the page and the service use), or a random one is generated and shown ONCE.
 * The service checks the rules again; nothing here is the last word.
 */
async function chooseVaultPassword(): Promise<string | null> {
  const lang = vaultLang()
  process.stdout.write(t('The vault password needs:\n', 'A senha do cofre precisa de:\n'))
  for (const r of VAULT_PASSWORD_RULES) process.stdout.write(`  · ${VAULT_PASSWORD_RULE_TEXT[r][lang]}\n`)
  process.stdout.write(t('It is never stored or sent anywhere: it only derives (scrypt, with a random salt) the key that opens the vault. Forgot it? The 24 words open the vault.\n',
    'Ela nunca é guardada nem enviada para lugar nenhum: só deriva (scrypt, com um sal aleatório) a chave que abre o cofre. Esqueceu? As 24 palavras abrem o cofre.\n'))
  if (await confirm(t('Generate a random one for you (shown once)?', 'Gerar uma aleatória para você (mostrada uma vez)?'), false)) {
    const g = generateVaultPassword()
    process.stdout.write('\n  ' + g + '\n\n' + t('Store it in your password manager now — it is not shown again.\n', 'Guarde no seu gerenciador de senhas agora — ela não aparece de novo.\n'))
    await pause(t('Press Enter when you have stored it', 'Aperte Enter quando tiver guardado'))
    clearScreen()
    return g
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = await maskedInput(t('New vault password', 'Nova senha do cofre'))
    const c = checkVaultPassword(p)
    if (!c.ok) { process.stderr.write(vaultPasswordWeakSentence(c, lang) + '\n'); continue }
    const again = await maskedInput(t('Type it again', 'Digite de novo'))
    if (again !== p) { process.stderr.write(t('The two did not match.\n', 'As duas não conferem.\n')); continue }
    return p
  }
  return null
}

async function enrolRecovery(): Promise<number> {
  const r = await askGated({ op: 'recovery-begin' })
  if (!r) return down()
  if (!r.ok) return said(r)
  const words = r.words as string[]
  const positions = r.positions as number[]
  process.stdout.write('\n' + t('Your recovery key — 24 words. Write them on paper:\n\n', 'Sua chave de recuperação — 24 palavras. Escreva em papel:\n\n'))
  for (const l of wordGrid(words)) process.stdout.write('  ' + l + '\n')
  process.stdout.write('\n' + t('Keep it offline. Anyone with these words and this computer can open your vault.\n', 'Guarde offline. Quem tiver estas palavras e este computador abre o seu cofre.\n'))
  process.stdout.write(t('It is shown once and cannot be shown again.\n', 'Ela é mostrada uma vez e não pode ser mostrada de novo.\n'))
  await pause(t('Press Enter when you have written them down', 'Aperte Enter quando tiver anotado'))
  clearScreen()
  words.fill('') // the only copy this process held
  process.stdout.write(t('Now type back three of the words to prove you have them.\n', 'Agora digite três das palavras para provar que você as tem.\n'))
  for (let attempt = 0; attempt < 3; attempt++) {
    const typed: string[] = []
    for (const p of positions) typed.push((await maskedInput(t(`Word #${p}`, `Palavra nº ${p}`))).trim().toLowerCase())
    const c = await ask({ op: 'recovery-confirm', typed })
    if (!c) return down()
    if (c.ok) { process.stdout.write(t('Recovery key saved. The previous one (if any) no longer works.\n', 'Chave de recuperação salva. A anterior (se havia) deixou de funcionar.\n')); return 0 }
    process.stderr.write(String(c.sentence) + '\n')
    if (c.code === 'no-recovery-pending') return 1
  }
  process.stderr.write(t('The words did not match. Start again with `agentop vault enroll --recovery` (you will get new words).\n', 'As palavras não conferiram. Recomece com `agentop vault enroll --recovery` (você receberá palavras novas).\n'))
  return 1
}

async function enrolPresence(kind: PresenceKind, recoveryPlanned = false): Promise<number> {
  // The vault password is chosen HERE and travels with the enrolment op only; a gesture is raised by the service.
  const chosen = kind === 'password' ? await chooseVaultPassword() : null
  if (kind === 'password' && !chosen) { process.stderr.write(t('No password was set; nothing was changed.\n', 'Nenhuma senha foi definida; nada foi alterado.\n')); return 1 }
  const pw = chosen ? { password: chosen } : {}
  process.stdout.write('\n' + (kind === 'hello'
    ? t('Windows Hello will ask you twice: once to create the vault\'s key, once to use it.\n', 'O Windows Hello vai pedir duas vezes: uma para criar a chave do cofre e uma para usá-la.\n')
    : kind === 'touchid'
      ? t('macOS will ask for Touch ID or your Mac password once.\n', 'O macOS vai pedir o Touch ID ou a senha do Mac uma vez.\n')
      : kind === 'password' ? ''
        : t('Agentistics is checking that your security key can protect your vault — touch it when it blinks (twice).\n', 'O Agentistics está verificando se a sua chave de segurança pode proteger o seu cofre — toque nela quando piscar (duas vezes).\n')))
  // Adding a SECOND way asks the first one (the service raises a gesture, or `askGated` asks for the old password).
  let r = await askGated({ op: 'presence-enroll', protector: kind, ...pw })
  if (r && !r.ok && r.code === 'presence-needs-recovery-words' && process.stdin.isTTY && process.stdout.isTTY) {
    // Review S7: presence makes a NEW vault key, and the recovery key must follow it — typed here, on the TTY.
    // Leader decision 2: the words are typed for THIS call only (never kept); without them, NEW words.
    process.stdout.write(t('Turning presence on replaces the vault key; your recovery key must follow it.\n', 'Ligar a presença troca a chave do cofre; a sua chave de recuperação precisa acompanhar.\n'))
    const words = (await maskedInput(t('Your 24 words (or press Enter with nothing to make NEW words instead)', 'Suas 24 palavras (ou Enter vazio para criar palavras NOVAS)'))).trim()
    if (words) {
      r = await askGated({ op: 'presence-enroll', protector: kind, words, ...pw })
    } else {
      const yes = await confirm(t('Make new recovery words after presence? Your OLD words will stop working.', 'Criar palavras de recuperação novas depois da presença? As palavras ANTIGAS deixam de funcionar.'), false)
      if (!yes) return 1
      r = await askGated({ op: 'presence-enroll', protector: kind, replaceRecovery: true, ...pw })
    }
  }
  if (!r) return down()
  if (!r.ok) return said(r)
  process.stdout.write(r.held === true
    // Leader decision 2026-10-02: nothing changes until the recovery key is confirmed — the LAST step.
    ? t('Presence is ready. It takes over when your recovery key is confirmed, in the next step; until then the vault is unchanged.\n', 'A presença está pronta. Ela assume quando a sua chave de recuperação for confirmada, no próximo passo; até lá o cofre não muda.\n')
    : t('Presence enrolled; the silent system wrapper was removed and the vault key replaced.\n', 'Presença configurada; o invólucro silencioso do sistema foi removido e a chave do cofre trocada.\n'))
  // The recovery key is owed now (none yet, or the old words were replaced): made right here, LAST.
  if (r.recoveryOwed === true && !recoveryPlanned) return enrolRecovery()
  return 0
}

/** §7.4: turning presence off. The main machine also needs the 24 words — typed here, never on a web form. */
async function cmdDisablePresence(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(t('Turning presence off is done on a terminal.\n', 'Desligar a presença é feito em um terminal.\n'))
    return 1
  }
  if (!(await askVaultSocket({ op: 'status' }))) return down()
  const view = await readView()
  if (!view?.presence) { process.stdout.write(t('This vault does not use presence.\n', 'Este cofre não usa presença.\n')); return 0 }
  process.stdout.write(t('Without presence, any program running as you could open the vault without asking.\n', 'Sem a presença, qualquer programa rodando como você poderia abrir o cofre sem perguntar.\n'))
  if (!(await confirm(t('Turn presence off?', 'Desligar a presença?'), false))) return 1
  const words = view.requirePresence ? await maskedInput(t('Your 24 words (this is the main machine)', 'Suas 24 palavras (esta é a máquina principal)')) : undefined
  const r = await askGated({ op: 'presence-disable', ...(words ? { words } : {}) })
  if (!r) return down()
  if (!r.ok) return said(r)
  process.stdout.write(t('Presence is off; the system protector holds the vault key again.\n', 'Presença desligada; o protetor do sistema voltou a guardar a chave do cofre.\n'))
  return 0
}

export async function runVault(args: string[]): Promise<number> {
  const [cmd, ...rest] = args
  // VAULT.PERSONAL §8.3 — the three verbs a granted session calls from INSIDE its commands and hooks.
  // They come before the vault consumers load: a hook runs on every tool call and must cost nothing.
  if (cmd === 'ref') return cmdRef(rest[0])
  if (cmd === 'pretool') return cmdPreTool()
  if (cmd === 'posttool') return cmdPostTool()
  await loadVaultConsumers()
  switch (cmd) {
    case undefined:
    case 'status': return cmdStatus(rest.includes('--json'))
    case 'init': return cmdInit(rest)
    case 'unlock': return cmdUnlock()
    case 'lock': return cmdLock()
    case 'rekey': return cmdRekey(rest)
    case 'add-passphrase': return cmdAddPassphrase()
    case 'reset': return cmdReset(rest)
    case 'recover': return cmdRecover()
    case 'setup-code': return cmdSetupCode()
    case 'enroll': return cmdEnroll(rest)
    case 'disable-presence': return cmdDisablePresence()
    case '--help': case '-h': case 'help':
      process.stdout.write(HELP + '\n')
      return 0
    default:
      process.stderr.write(HELP + '\n')
      return 2
  }
}

// ── VAULT.PERSONAL §8.3: inside a granted session ───────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
const managedId = () => process.env.AGENTOP_MANAGED_ID ?? ''

/** `agentop vault ref vault://key[/field]` — the value of a GRANTED reference, to stdout, for the command that runs it. */
async function cmdRef(ref: string | undefined): Promise<number> {
  const { askVault } = await import('./vault/socket')
  if (!ref || !managedId()) { process.stderr.write(t('agentop vault ref: run inside a session agentop started, with a granted reference.\n', 'agentop vault ref: rode dentro de uma sessão iniciada pelo agentop, com uma referência liberada.\n')); return 2 }
  const r = await askVault({ op: 'personal-ref', managedId: managedId(), ref })
  const rep = r?.reply as { ok?: boolean; value?: string; sentence?: string } | undefined
  if (!rep?.ok || typeof rep.value !== 'string') { process.stderr.write(`agentop: ${rep?.sentence ?? t('the vault service did not answer.', 'o serviço do cofre não respondeu.')}\n`); return 1 }
  process.stdout.write(rep.value)
  return 0
}

/** Claude Code PreToolUse (Bash): rewrite granted references; print nothing otherwise. */
async function cmdPreTool(): Promise<number> {
  if (!managedId()) return 0
  const raw = await readStdin()
  if (!raw.includes('vault://')) return 0
  let input: { tool_name?: string; tool_input?: Record<string, unknown> }
  try { input = JSON.parse(raw) } catch { return 0 }
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : null
  if (input.tool_name !== 'Bash' || !command) return 0
  const { askVault } = await import('./vault/socket')
  const refs = ((await askVault({ op: 'personal-refs', managedId: managedId() }))?.reply as { refs?: string[] } | undefined)?.refs ?? []
  const { rewriteVaultRefs, preToolAnswer } = await import('./vault/hook-rewrite')
  const { hookInvocation } = await import('./claude-hooks')
  const out = rewriteVaultRefs(command, refs, hookInvocation({ onPath: false, execPath: process.execPath, script: process.argv[1] }))
  if (out) process.stdout.write(preToolAnswer(input.tool_input!, out))
  return 0
}

/** Claude Code PostToolUse: scrub the tool's output for this session's grant; print nothing when nothing changed. */
async function cmdPostTool(): Promise<number> {
  if (!managedId()) return 0
  const raw = await readStdin()
  let input: { tool_response?: unknown }
  try { input = JSON.parse(raw) } catch { return 0 }
  if (input.tool_response === undefined) return 0
  const { askVault } = await import('./vault/socket')
  const { postToolDecision, grantMarkerName, HOOK_ASK_TIMEOUT_MS } = await import('./vault/hook-rewrite')
  const text = JSON.stringify(input.tool_response)
  let r: { ok?: boolean; changed?: boolean; text?: string } | undefined
  try { r = (await askVault({ op: 'personal-scrub', managedId: managedId(), text }, { timeoutMs: HOOK_ASK_TIMEOUT_MS }))?.reply as typeof r } catch { r = undefined }
  let hadGrant = true // unknown reads as "had one": fail closed
  if (!r?.ok) {
    const { join } = await import('node:path')
    const { runDir } = await import('./vault/service')
    hadGrant = await grantMarkerExists(join(runDir(), grantMarkerName(managedId()!)))
  }
  const ans = postToolDecision(input.tool_response, r, hadGrant)
  if (ans) process.stdout.write(ans)
  return 0
}

/** Missing history means no grant; an unreadable history remains fail-closed. */
export async function grantMarkerExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}
