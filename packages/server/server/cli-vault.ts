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
import {
  checkPassphrase, destroyVault, migratedSentence, passphraseCheckSentence, refusalSentence,
  type ProtectorId,
} from '@agentistics/vault'
import { realProtectorIo } from './vault/io'
import {
  allRestoreWith, displayPath, pendingPlaintextFiles, protectorById, vaultDir, vaultExists, vaultLang, vaultStatus,
  type VaultStatus,
} from './vault/service'
import { askVault, askVaultSocket, type SocketReply } from './vault/socket'
import { loadVaultConsumers, pendingSecretValues, sealedFiles } from './vault/boot'
import { clearScreen, confirm, maskedInput, pause } from './cli-ui'
import { parseEnrolArgs, pickPresence, qrHalfBlocks, stepsToRun, wordGrid } from './vault/enroll-plan'

const HELP = `Usage: agentop vault <command>

  status [--json]          the vault's state, protector, sealed files and pending plaintext
  init [--protector <id>]  create the vault (the system protector; another only when named here)
  unlock                   give a locked service its passphrase (typed here, never echoed)
  lock                     drop the key from the running service
  rekey --protector <id>   move the vault to another protector (keychain|dpapi|libsecret|systemd-creds|passphrase)
  add-passphrase           add a passphrase wrapper beside the system one (how a Docker machine opens it)
  reset [--yes]            delete the vault and every sealed file — the secrets are then re-entered
  enroll                   make the vault ultra secure: authenticator, recovery key, presence (what is still missing)
        [--authenticator] [--recovery] [--presence hello|fido2] [--require-presence]
  recover                  open the vault with your 24-word recovery key (terminal only)
  disable-presence         turn presence off (code + gesture; the main machine also needs the 24 words)

There is no command that decrypts secrets back to plain text.`

function t(en: string, pt: string): string {
  return vaultLang() === 'pt' ? pt : en
}

/** The slice of `GET /api/vault` the §7.2 status adds (`view` op): never a secret, never a value. */
interface View {
  presence?: boolean; presenceAvailable?: string[]; requirePresence?: boolean; recoveryCreatedAt?: string | null
  authenticator?: { enrolledAt: string; lastUsedAt: string | null; failures: number; pausedUntil: string | null; frozen: boolean } | null
  autoLockMinutes?: number; autoLockInMs?: number | null; pendingStepup?: boolean
  recoveryTodo?: string[] | null
  hardening?: { state: string; private: boolean | null; coreDumps: string | null; yama: string | null; lines: string[] } | null
}

function minutesWords(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / 60_000))
  return t(`${m} min`, `${m} min`)
}

function printSecurity(v: View, wrappers: string[]): void {
  const out = (k: string, val: string) => process.stdout.write(`${k}: ${val}\n`)
  out(t('scope', 'escopo'), t('human', 'humano'))
  const pres = wrappers.filter(w => w === 'hello' || w === 'fido2')
  out(t('presence', 'presença'), pres.length
    ? `${pres.join(', ')}${v.requirePresence ? t(' (main machine: required)', ' (máquina principal: obrigatória)') : ''}`
    : (v.presenceAvailable?.length ? t('off (can be enrolled: ', 'desligada (pode ser configurada: ') + v.presenceAvailable.join(', ') + ')' : t('not available on this machine', 'indisponível nesta máquina')))
  const a = v.authenticator
  if (!a) out(t('authenticator', 'autenticador'), t('not set up', 'não configurado'))
  else {
    const state = a.frozen ? t('FROZEN — re-enrol with the recovery key', 'CONGELADO — configure de novo com a chave de recuperação')
      : a.pausedUntil ? t(`paused until ${a.pausedUntil}`, `pausado até ${a.pausedUntil}`) : t('ready', 'pronto')
    out(t('authenticator', 'autenticador'), `${state}; ${t('failed attempts', 'tentativas erradas')}: ${a.failures}${a.lastUsedAt ? `; ${t('last used', 'último uso')} ${a.lastUsedAt}` : ''}`)
  }
  out(t('recovery key', 'chave de recuperação'), v.recoveryCreatedAt ? `${t('created', 'criada em')} ${v.recoveryCreatedAt}` : t('not created', 'não criada'))
  if (v.pendingStepup) out(t('unlock', 'desbloqueio'), t('waiting for your authenticator code', 'esperando o código do autenticador'))
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

/** A 6-digit authenticator code, typed on the TTY (never echoed, never on argv). */
async function askCode(): Promise<string | null> {
  if (!process.stdin.isTTY) { process.stderr.write(refusalSentence('stepup-required', vaultLang()) + t(' (a terminal is needed to type it)\n', ' (é preciso um terminal para digitá-lo)\n')); return null }
  const c = (await maskedInput(t('Authenticator code', 'Código do autenticador'))).replace(/\s/g, '')
  return c || null
}

/** Ask a gated op; when the service says a code is needed, ask for it on the TTY and ask again. */
async function askGated(req: Record<string, unknown> & { op: string }): Promise<SocketReply | null> {
  let r = await ask(req)
  for (let i = 0; r && !r.ok && (r.code === 'stepup-required' || r.code === 'stepup-wrong' || r.code === 'stepup-replayed') && i < 3; i++) {
    if (r.code !== 'stepup-required') process.stderr.write(String(r.sentence) + '\n')
    const code = await askCode()
    if (!code) return r
    r = await ask({ ...req, code })
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
  // §2.2: the SERVICE raises the gesture (Windows Hello, the security key); the code follows here.
  if (st.ok && (st.status?.wrappers ?? []).some(w => w === 'hello' || w === 'fido2')) {
    process.stdout.write(t('Confirm on the presence prompt the service is raising…\n', 'Confirme no pedido de presença que o serviço está abrindo…\n'))
  }
  const svc = await ask({ op: 'unlock', ...(pass ? { passphrase: pass } : {}) }, { timeoutMs: 180_000 })
  if (!svc) return down()
  if (!svc.ok) return said(svc)
  if (svc.unlock === 'pending-stepup') {
    // ONE attempt per gesture: a wrong code zeroes the key in the service (§2.2).
    const code = await askCode()
    if (!code) return 1
    const r = await ask({ op: 'unlock-code', code })
    if (!r) return down()
    if (!r.ok) return said(r)
  }
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
    'Provider keys (~/.agentistics/provider-keys) belong to the engine and are not touched here; without this vault they no longer open — re-enter them with `agentop provider key set <provider>`.\n',
    'As chaves de provedor (~/.agentistics/provider-keys) pertencem ao motor e não são tocadas aqui; sem este cofre elas não abrem mais — cadastre-as de novo com `agentop provider key set <provider>`.\n'))
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
 * three steps are owed: presence, the authenticator, a NEW recovery key (the old words were just typed).
 */
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
 * §7.3 `agentop vault enroll` — TTY ONLY (a QR and 24 words are for a person looking at a screen).
 * Runs what is still missing, in the one safe order: authenticator (QR + two codes), the recovery key
 * (shown once, three words typed back), then presence, which is the step that retires the silent OS
 * wrapper — written and read back before the old one goes, so a crash anywhere leaves the vault
 * openable. Every step is a request to the SERVICE; this process never holds a key or a seed.
 */
async function cmdEnroll(args: string[]): Promise<number> {
  const parsed = parseEnrolArgs(args)
  if (!parsed.ok) {
    process.stderr.write((parsed.deferred === 'se'
      ? t('Touch ID / Secure Enclave is not available yet (it waits on a signed helper). Use --presence fido2 with a security key.\n',
        'Touch ID / Secure Enclave ainda não está disponível (depende de um helper assinado). Use --presence fido2 com uma chave de segurança.\n')
      : parsed.usage + '\n'))
    return 2
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(t('Enrolment needs a terminal: it shows a QR code and 24 words that are never written anywhere else.\n',
      'A configuração precisa de um terminal: ela mostra um QR e 24 palavras que não são gravadas em nenhum outro lugar.\n'))
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
  const state = () => ({ authenticator: Boolean(view?.authenticator), recovery: Boolean(view?.recoveryCreatedAt), presence: Boolean(view?.presence), available: view?.presenceAvailable ?? [] })
  const steps = stepsToRun(parsed.value, state())
  if (steps.length === 0) {
    process.stdout.write(t('Nothing left to set up: the authenticator, the recovery key and presence are all in place.\n', 'Nada a configurar: autenticador, chave de recuperação e presença já estão ativos.\n'))
    return cmdStatus(false)
  }
  const presence = pickPresence(parsed.value.presence, state().available)
  if (steps.includes('presence') && !presence) {
    process.stderr.write(t('Presence is not available here (no Windows Hello and no security-key support on this machine).\n', 'A presença não está disponível aqui (sem Windows Hello e sem suporte a chave de segurança nesta máquina).\n'))
    return 1
  }
  for (const step of steps) {
    const rc = step === 'authenticator' ? await enrolAuthenticator() : step === 'recovery' ? await enrolRecovery() : await enrolPresence(presence!)
    if (rc !== 0) return rc
  }
  view = await readView()
  const pres = view?.presence ? t('Windows Hello or your security key', 'o Windows Hello ou a sua chave de segurança') : null
  if (steps.includes('presence') && pres) {
    process.stdout.write('\n' + t(
      `Done. From now on the vault opens only with ${pres} and your code. It locks itself after ${view?.autoLockMinutes ?? 30} minutes without use. Keep your 24 words offline.\n`,
      `Pronto. A partir de agora o cofre só abre com ${pres} e o seu código. Ele trava sozinho depois de ${view?.autoLockMinutes ?? 30} minutos sem uso. Guarde as suas 24 palavras offline.\n`))
  }
  return 0
}

async function enrolAuthenticator(): Promise<number> {
  const a = await askGated({ op: 'authenticator-begin' })
  if (!a) return down()
  if (!a.ok) return said(a)
  process.stdout.write('\n' + t('Scan this with your authenticator app (Google Authenticator, Authy, 1Password…):\n\n', 'Escaneie com o seu app autenticador (Google Authenticator, Authy, 1Password…):\n\n'))
  for (const l of qrHalfBlocks(String(a.uri))) process.stdout.write('  ' + l + '\n')
  process.stdout.write('\n' + t('Cannot scan it? Type this key into the app:\n', 'Não consegue escanear? Digite esta chave no app:\n'))
  process.stdout.write('  ' + String(a.secret).match(/.{1,4}/g)?.join(' ') + '\n\n')
  process.stdout.write(t('Then type two codes in a row (wait for the app to show the next one):\n', 'Depois digite dois códigos seguidos (espere o app mostrar o próximo):\n'))
  for (let attempt = 0; attempt < 3; attempt++) {
    const c1 = (await maskedInput(t('First code', 'Primeiro código'))).replace(/\s/g, '')
    const c2 = (await maskedInput(t('Next code', 'Código seguinte'))).replace(/\s/g, '')
    const r = await ask({ op: 'authenticator-confirm', code1: c1, code2: c2 })
    if (!r) return down()
    if (r.ok) { process.stdout.write(t('Authenticator set up.\n', 'Autenticador configurado.\n')); return 0 }
    process.stderr.write(String(r.sentence) + '\n')
    if (r.code === 'no-enrolment') return 1
  }
  process.stderr.write(t('Start again with `agentop vault enroll --authenticator`.\n', 'Recomece com `agentop vault enroll --authenticator`.\n'))
  return 1
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

async function enrolPresence(kind: 'hello' | 'fido2'): Promise<number> {
  process.stdout.write('\n' + (kind === 'hello'
    ? t('Agentistics is checking that Windows Hello can protect your vault — confirm twice.\n', 'O Agentistics está verificando se o Windows Hello pode proteger o seu cofre — confirme duas vezes.\n')
    : t('Agentistics is checking that your security key can protect your vault — touch it when it blinks (twice).\n', 'O Agentistics está verificando se a sua chave de segurança pode proteger o seu cofre — toque nela quando piscar (duas vezes).\n')))
  const r = await askGated({ op: 'presence-enroll', protector: kind })
  if (!r) return down()
  if (!r.ok) return said(r)
  process.stdout.write(t('Presence enrolled; the silent system wrapper was removed.\n', 'Presença configurada; o invólucro silencioso do sistema foi removido.\n'))
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
  await loadVaultConsumers()
  const [cmd, ...rest] = args
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
