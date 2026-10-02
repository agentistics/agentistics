/**
 * cli-vault.ts — `agentop vault init|status|unlock|lock|rekey|add-passphrase|reset`.
 *
 * The verbs over the machine's vault (docs/security.md § "Secrets at rest"). What a verb can ask the
 * RUNNING service it asks over the unlock socket (`status`, `unlock`, `lock`), so it neither pays
 * ~0.7 s for `powershell.exe` nor opens a second copy of the key; what changes the vault itself
 * (`init`, `rekey`, `add-passphrase`, `reset`) runs here.
 *
 * There is deliberately NO verb that decrypts everything back to plain text: it would be a supported
 * path to the forbidden state. Leaving the vault is `reset` (which deletes it and every sealed file,
 * after a confirmation naming each) and re-entering the secrets.
 */
import { existsSync, rmSync } from 'node:fs'
import {
  addPassphraseWrapper, checkPassphrase, destroyVault, initSentence,
  migratedSentence, passphraseCheckSentence, rekeyVault, refusalSentence, checkedList,
  type Protector, type ProtectorId,
} from '@agentistics/vault'
import { realProtectorIo } from './vault/io'
import {
  adoptCreated, allRestoreWith, chooseAutoProtector, createVault, displayPath, pendingPlaintextFiles, ensureVaultOpen, protectorById, protectorLabel,
  runMigrations, unlockVault, vaultAudit, vaultDir, vaultExists, vaultLang, vaultStatus, lockVault,
  setVaultInitReporter, type VaultStatus,
} from './vault/service'
import { askVaultSocket } from './vault/socket'
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

async function cmdStatus(json: boolean): Promise<number> {
  const viaService = await askVaultSocket({ op: 'status' })
  // No service to ask: try to open it HERE (never creating one), so "locked" means the protector
  // really did not open it rather than "this process did not try".
  if (!viaService && vaultExists()) await ensureVaultOpen({ create: false, migrate: false })
  const s = viaService && viaService.ok && viaService.status ? viaService.status : await vaultStatus()
  const sealed = sealedFiles()
  const pendingFiles = await pendingPlaintextFiles()
  if (json) {
    process.stdout.write(JSON.stringify({ ...s, sealedFiles: sealed.map(displayPath), pendingFiles: pendingFiles.map(displayPath), service: Boolean(viaService) }, null, 2) + '\n')
  } else {
    printStatus(s, sealed, pendingFiles)
  }
  return 0
}

const PROTECTOR_IDS: ProtectorId[] = ['keychain', 'dpapi', 'libsecret', 'systemd-creds', 'passphrase']

async function cmdInit(args: string[]): Promise<number> {
  const i = args.indexOf('--protector')
  const asked = i !== -1 ? args[i + 1] as ProtectorId | undefined : undefined
  if (i !== -1 && (!asked || !PROTECTOR_IDS.includes(asked))) {
    process.stderr.write(`usage: agentop vault init [--protector ${PROTECTOR_IDS.join('|')}]\n`)
    return 2
  }
  if (vaultExists()) {
    process.stdout.write(t('This machine already has a vault.\n\n', 'Esta máquina já tem um cofre.\n\n'))
    const o = await ensureVaultOpen({ create: false, migrate: false })
    if (o) await report(await runMigrations(true))
    return cmdStatus(false)
  }
  setVaultInitReporter(() => { /* said below */ })
  let protector: Protector
  let pass: string | undefined
  if (asked) {
    // An EXPLICIT choice — the only way a protector other than the platform's own is used.
    if (asked === 'passphrase') {
      const p = await askPassphrase(true)
      if (!p) return 1
      pass = p
    }
    protector = protectorById(asked, pass)!
    const probe = await protector.probe()
    if (!probe.ok) { process.stderr.write(`agentop: ${asked} — ${probe.reason}\n`); return 1 }
  } else {
    const choice = await chooseAutoProtector()
    if (choice.ok) {
      protector = choice.protector
    } else if (choice.kind === 'unavailable') {
      process.stderr.write(refusalSentence('protector-unavailable', vaultLang(), { protector: choice.protector.label(vaultLang()), reason: choice.reason }) + '\n')
      return 1
    } else {
      process.stdout.write(refusalSentence('no-protector', vaultLang(), { checked: checkedList(choice.checked, vaultLang()) }) + '\n\n')
      const p = await askPassphrase(true)
      if (!p) return 1
      pass = p
      protector = protectorById('passphrase', pass)!
    }
  }
  const made = await createVault(protector, pass)
  if (!made.ok) {
    if (made.reason === 'exists') return cmdInit([])
    process.stderr.write(`agentop: ${made.reason}\n`)
    return 1
  }
  adoptCreated(made.state)
  vaultAudit({ type: 'vault.init', protector: protector.id })
  process.stdout.write(initSentence(protector.label(vaultLang()), vaultLang()) + '\n')
  await report(await runMigrations(true))
  const svc = await askVaultSocket({ op: 'status' })
  if (svc && svc.ok && svc.status?.state === 'locked') {
    process.stdout.write(t('\nThe running agentop service started before this vault existed — restart it, or run `agentop vault unlock`.\n',
      '\nO serviço do agentop em execução iniciou antes deste cofre existir — reinicie-o, ou rode `agentop vault unlock`.\n'))
  }
  return 0
}

async function report(r: { migrated: number; lines: string[] }): Promise<void> {
  for (const l of r.lines) process.stdout.write(l + '\n')
  if (r.migrated > 0) process.stdout.write(migratedSentence(r.migrated, allRestoreWith(), vaultLang()) + '\n')
}

async function cmdUnlock(): Promise<number> {
  const pass = await askPassphrase(false)
  if (!pass) return 1
  const svc = await askVaultSocket({ op: 'unlock', passphrase: pass })
  if (svc) {
    if (!svc.ok) { process.stderr.write(svc.sentence + '\n'); return 1 }
    process.stdout.write(t('The agentop service unlocked its vault.\n', 'O serviço do agentop destrancou o cofre.\n'))
    return 0
  }
  // No service to hand it to: unlock HERE, so this command at least migrates what is waiting.
  const u = await unlockVault(pass)
  if (!u.ok) { process.stderr.write(u.sentence + '\n'); return 1 }
  await report(await runMigrations(true))
  process.stdout.write(t('No agentop service is running; the vault was opened for this command only.\n',
    'Nenhum serviço do agentop está rodando; o cofre foi aberto só para este comando.\n'))
  return 0
}

async function cmdLock(): Promise<number> {
  const svc = await askVaultSocket({ op: 'lock' })
  if (!svc) { process.stdout.write(t('No agentop service is running — nothing holds the key.\n', 'Nenhum serviço do agentop está rodando — nada guarda a chave.\n')); return 0 }
  process.stdout.write(t('The agentop service dropped the vault key.\n', 'O serviço do agentop descartou a chave do cofre.\n'))
  return 0
}

async function openHere(): Promise<Awaited<ReturnType<typeof ensureVaultOpen>>> {
  let o = await ensureVaultOpen({ create: false, migrate: false })
  if (!o) {
    const s = await vaultStatus()
    if (s.state === 'locked' && s.wrappers.includes('passphrase')) {
      const pass = await askPassphrase(false)
      if (pass && (await unlockVault(pass)).ok) o = await ensureVaultOpen({ create: false, migrate: false })
    }
    if (!o) process.stderr.write((s.sentence ?? refusalSentence('uninitialized', vaultLang())) + '\n')
  }
  return o
}

async function cmdRekey(args: string[]): Promise<number> {
  const i = args.indexOf('--protector')
  const id = (i !== -1 ? args[i + 1] : undefined) as ProtectorId | undefined
  if (!id || !['keychain', 'dpapi', 'libsecret', 'systemd-creds', 'passphrase'].includes(id)) {
    process.stderr.write('usage: agentop vault rekey --protector keychain|dpapi|libsecret|systemd-creds|passphrase\n')
    return 2
  }
  const o = await openHere()
  if (!o) return 1
  const pass = id === 'passphrase' ? await askPassphrase(true) : undefined
  if (id === 'passphrase' && !pass) return 1
  const next = protectorById(id, pass ?? undefined)
  if (!next) return 1
  const probe = await next.probe()
  if (!probe.ok) { process.stderr.write(`agentop: ${id} — ${probe.reason}\n`); return 1 }
  const old = o.vault.wrappers.map(w => protectorById(w.type)).filter((p): p is NonNullable<typeof p> => p !== null)
  const r = await rekeyVault(realProtectorIo(), vaultDir(), { state: 'open', ...o }, next, old)
  if (!r.ok) { process.stderr.write(`agentop: ${r.reason}\n`); return 1 }
  vaultAudit({ type: 'vault.rekey', protector: id })
  process.stdout.write(t(`The vault key is now kept by ${protectorLabel(id)}.\n`, `A chave do cofre agora é guardada por ${protectorLabel(id)}.\n`))
  return 0
}

async function cmdAddPassphrase(): Promise<number> {
  const o = await openHere()
  if (!o) return 1
  process.stdout.write(t(
    'A passphrase wrapper is an OFFLINE brute-force target beside the files it opens: choose a long one.\n',
    'Um invólucro de frase-senha é um alvo de força bruta OFFLINE ao lado dos arquivos que ele abre: escolha uma longa.\n'))
  const pass = await askPassphrase(true)
  if (!pass) return 1
  const r = await addPassphraseWrapper(realProtectorIo(), vaultDir(), { state: 'open', ...o }, protectorById('passphrase', pass)!)
  if (!r.ok) { process.stderr.write(`agentop: ${r.reason}\n`); return 1 }
  vaultAudit({ type: 'vault.add-passphrase' })
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
  const s = await vaultStatus()
  const protectors = s.wrappers.map(w => protectorById(w)).filter((p): p is NonNullable<typeof p> => p !== null)
  lockVault()
  await askVaultSocket({ op: 'lock' })
  await destroyVault(realProtectorIo(), vaultDir(), protectors)
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
