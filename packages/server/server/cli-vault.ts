/**
 * cli-vault.ts — `agentop vault init|status|unlock|lock|rekey|add-passphrase|reset`.
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
import { confirm, maskedInput } from './cli-ui'

const HELP = `Usage: agentop vault <command>

  status [--json]          the vault's state, protector, sealed files and pending plaintext
  init [--protector <id>]  create the vault (the system protector; another only when named here)
  unlock                   give a locked service its passphrase (typed here, never echoed)
  lock                     drop the key from the running service
  rekey --protector <id>   move the vault to another protector (keychain|dpapi|libsecret|systemd-creds|passphrase)
  add-passphrase           add a passphrase wrapper beside the system one (how a Docker machine opens it)
  reset [--yes]            delete the vault and every sealed file — the secrets are then re-entered

There is no command that decrypts secrets back to plain text.`

function t(en: string, pt: string): string {
  return vaultLang() === 'pt' ? pt : en
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
  const r = await askVault(req, { timeoutMs: opts.timeoutMs ?? 120_000, ...(opts.body ? { body: opts.body } : {}) })
  return r ? r.reply : null
}

function down(): number {
  process.stderr.write(refusalSentence('service-down', vaultLang()) + '\n')
  return 1
}

function said(r: SocketReply): number {
  if (r.ok) return 0
  process.stderr.write(String(r.sentence) + '\n')
  return 1
}

async function cmdStatus(json: boolean): Promise<number> {
  const viaService = await askVaultSocket({ op: 'status' })
  const s = viaService && viaService.ok && viaService.status ? viaService.status : await vaultStatus()
  const sealed = sealedFiles()
  const pendingFiles = await pendingPlaintextFiles()
  if (json) {
    process.stdout.write(JSON.stringify({ ...s, sealedFiles: sealed.map(displayPath), pendingFiles: pendingFiles.map(displayPath), service: Boolean(viaService) }, null, 2) + '\n')
  } else {
    printStatus(s, sealed, pendingFiles)
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
  const svc = await ask({ op: 'unlock', ...(pass ? { passphrase: pass } : {}) })
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
  const r = await ask({ op: 'vault-rekey', protector: id, ...(pass ? { passphrase: pass } : {}) })
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
  const r = await ask({ op: 'vault-add-passphrase', passphrase: pass })
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
  const svc = await ask({ op: 'vault-reset' })
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
    case '--help': case '-h': case 'help':
      process.stdout.write(HELP + '\n')
      return 0
    default:
      process.stderr.write(HELP + '\n')
      return 2
  }
}
