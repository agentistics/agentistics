/**
 * sentences.ts — every refusal the vault can give, as a CODE plus a SENTENCE, in English and
 * Brazilian Portuguese. PURE.
 *
 * The rule the whole feature is held to: a secret that cannot be stored or read is said in words —
 * which state the vault is in, what was checked, and the command that fixes it. `{restoreWith}` is
 * never written here: the host passes the command from `backup-plan.ts`'s `secret` rows
 * (`omittedSecrets()`), so the command a refusal names and the one a restore prints are the same
 * string and cannot drift apart.
 *
 * No sentence ever contains a secret, a fragment of one, or its length.
 */

export type Lang = 'en' | 'pt'

export type VaultRefusal =
  | 'uninitialized'
  | 'locked'
  | 'no-protector'
  | 'protector-lost'
  | 'wrong-machine'
  | 'tampered'
  | 'plaintext-pending'
  | 'migration-failed'
  /** engine-api 1.5: an engine asked for a purpose outside `engine/…`. */
  | 'purpose'
  /** The platform's protector did not answer; no weaker one is chosen on its own. */
  | 'protector-unavailable'
  /** A plaintext copy and its sealed copy disagree; both kept. */
  | 'conflict'

export interface SentenceArgs {
  /** The file the refusal is about, as the user would find it (`~/.agentistics/…`). */
  file?: string
  /** The command(s) that re-establish the secret — from `omittedSecrets()`. */
  restoreWith?: string
  /** The protector, named the way the user knows it (`protectorLabel`). */
  protector?: string
  /** Why something failed, already in words and free of any secret. */
  reason?: string
  /** The kid a foreign file was sealed under. */
  kid?: string
  /** A count. */
  n?: number
  /** What detection checked, already in words (`checkedList`). */
  checked?: string
}

const EN: Record<VaultRefusal, (a: SentenceArgs) => string> = {
  uninitialized: () =>
    'There is no vault on this machine yet, so this secret cannot be stored — Agentistics never writes one in plain text. Run `agentop vault init`.',
  locked: () =>
    'The vault is locked: the agentop service started without its passphrase. Run `agentop vault unlock`. Until then provider keys, the GitHub backup token and central tokens cannot be read, and only what needs them is paused.',
  'no-protector': (a) =>
    `This machine has no system keychain Agentistics can use (checked: ${a.checked ?? 'nothing'}). Secrets are never stored in plain text, so they will be protected by a passphrase you choose. You will type it once each time the agentop service starts.`,
  'protector-lost': (a) =>
    `The vault key is protected by ${a.protector ?? 'the system keychain'}, and ${a.protector ?? 'it'} no longer opens it (${a.reason ?? 'no reason given'}). The secrets in ~/.agentistics cannot be read on this machine any more. Nothing was deleted. Re-enter them with: ${a.restoreWith ?? 'the commands `agentop vault status` lists'}.`,
  'wrong-machine': (a) =>
    `${a.file ?? 'This file'} was sealed by another machine's vault (key ${a.kid ?? 'unknown'}) — copied from a backup or another computer. It cannot be opened here, by design. Re-enter it with: ${a.restoreWith ?? 'the command that set it'}.`,
  tampered: (a) =>
    `${a.file ?? 'This file'} failed its integrity check (it was modified, or moved from another file). It was not used. Re-enter it with: ${a.restoreWith ?? 'the command that set it'}.`,
  'plaintext-pending': (a) =>
    `${a.n ?? 0} secret(s) are still stored in plain text from an earlier version. They are encrypted as soon as the vault is open — run \`agentop vault unlock\` (or \`agentop vault init\`).`,
  'migration-failed': (a) =>
    `${a.file ?? 'A secret file'} could not be encrypted (${a.reason ?? 'unknown error'}). The original was left untouched and will be retried at the next start.`,
  purpose: () =>
    'An engine may only seal and open its own secrets (a purpose starting with `engine/`); this request named another and was refused.',
  'protector-unavailable': (a) =>
    `${a.protector ?? 'The system keychain'} did not answer (${a.reason ?? 'no reason given'}), so no vault was created and nothing was stored — Agentistics never writes a secret in plain text and never falls back to a weaker protector on its own. It is retried automatically; to choose another protector, run \`agentop vault init --protector libsecret|systemd-creds|passphrase\`.`,
  conflict: (a) =>
    `${a.file ?? 'A secret file'} is still in plain text and differs from its encrypted copy (an older agentop re-entered it after it was encrypted). Both were kept and nothing was deleted. Keep the one you want: re-enter it with ${a.restoreWith ?? 'the command that set it'}, or delete the plain-text file to keep the encrypted one.`,
}

const PT: Record<VaultRefusal, (a: SentenceArgs) => string> = {
  uninitialized: () =>
    'Ainda não existe um cofre nesta máquina, então este segredo não pode ser guardado — o Agentistics nunca grava um em texto puro. Rode `agentop vault init`.',
  locked: () =>
    'O cofre está trancado: o serviço do agentop iniciou sem a frase-senha. Rode `agentop vault unlock`. Até lá as chaves de provedor, o token do backup no GitHub e os tokens de central não podem ser lidos, e só o que depende deles fica pausado.',
  'no-protector': (a) =>
    `Esta máquina não tem um chaveiro do sistema que o Agentistics possa usar (verificado: ${a.checked ?? 'nada'}). Segredos nunca são guardados em texto puro, então serão protegidos por uma frase-senha que você escolhe. Você vai digitá-la uma vez a cada início do serviço do agentop.`,
  'protector-lost': (a) =>
    `A chave do cofre é protegida por ${a.protector ?? 'o chaveiro do sistema'}, e ${a.protector ?? 'ele'} não a abre mais (${a.reason ?? 'sem motivo informado'}). Os segredos em ~/.agentistics não podem mais ser lidos nesta máquina. Nada foi apagado. Cadastre-os de novo com: ${a.restoreWith ?? 'os comandos que `agentop vault status` lista'}.`,
  'wrong-machine': (a) =>
    `${a.file ?? 'Este arquivo'} foi selado pelo cofre de outra máquina (chave ${a.kid ?? 'desconhecida'}) — copiado de um backup ou de outro computador. Ele não pode ser aberto aqui, por projeto. Cadastre-o de novo com: ${a.restoreWith ?? 'o comando que o definiu'}.`,
  tampered: (a) =>
    `${a.file ?? 'Este arquivo'} falhou na verificação de integridade (foi modificado, ou movido de outro arquivo). Ele não foi usado. Cadastre-o de novo com: ${a.restoreWith ?? 'o comando que o definiu'}.`,
  'plaintext-pending': (a) =>
    `${a.n ?? 0} segredo(s) ainda estão guardados em texto puro, de uma versão anterior. Eles são cifrados assim que o cofre estiver aberto — rode \`agentop vault unlock\` (ou \`agentop vault init\`).`,
  'migration-failed': (a) =>
    `${a.file ?? 'Um arquivo de segredo'} não pôde ser cifrado (${a.reason ?? 'erro desconhecido'}). O original foi mantido intacto e será tentado de novo no próximo início.`,
  purpose: () =>
    'Um motor só pode selar e abrir os próprios segredos (um propósito que começa com `engine/`); este pedido nomeou outro e foi recusado.',
  'protector-unavailable': (a) =>
    `${a.protector ?? 'O chaveiro do sistema'} não respondeu (${a.reason ?? 'sem motivo informado'}), então nenhum cofre foi criado e nada foi guardado — o Agentistics nunca grava um segredo em texto puro e nunca recorre sozinho a um protetor mais fraco. Isso é tentado de novo automaticamente; para escolher outro protetor, rode \`agentop vault init --protector libsecret|systemd-creds|passphrase\`.`,
  conflict: (a) =>
    `${a.file ?? 'Um arquivo de segredo'} ainda está em texto puro e difere da cópia cifrada (um agentop antigo o recadastrou depois de cifrado). Os dois foram mantidos e nada foi apagado. Fique com o que você quer: cadastre-o de novo com ${a.restoreWith ?? 'o comando que o definiu'}, ou apague o arquivo em texto puro para ficar com o cifrado.`,
}

/** PURE. The sentence for a refusal. */
export function refusalSentence(code: VaultRefusal, lang: Lang, args: SentenceArgs = {}): string {
  return (lang === 'pt' ? PT : EN)[code](args)
}

/** PURE. The one line said when a vault is created. */
export function initSentence(protector: string, lang: Lang): string {
  return lang === 'pt'
    ? `Os segredos agora são cifrados nesta máquina. A chave que os abre é guardada por ${protector}. Nada é guardado em texto puro.`
    : `Secrets are now encrypted on this machine. The key that opens them is kept by ${protector}. Nothing is stored in plain text.`
}

/** PURE. The migration's closing line (§3.5) — said once, and honest about the past. */
export function migratedSentence(n: number, restoreWith: string, lang: Lang): string {
  return lang === 'pt'
    ? `${n} segredo(s) agora estão cifrados. Cópias feitas antes de hoje (backups, snapshots, pastas sincronizadas) ainda podem tê-los em texto puro — trocar essas chaves fecha isso: ${restoreWith}.`
    : `${n} secret(s) are now encrypted. Copies made before today (backups, snapshots, synced folders) may still hold them in plain text — rotating these keys closes that: ${restoreWith}.`
}

/**
 * Thrown by a WRITE path that cannot proceed without leaving a secret in plain text. Carries the
 * code and an already-composed sentence; the message IS the sentence, so a caller that prints
 * `err.message` prints the right thing. It never carries the value it refused to write.
 */
export class VaultRefusalError extends Error {
  readonly code: VaultRefusal
  constructor(code: VaultRefusal, sentence: string) {
    super(sentence)
    this.name = 'VaultRefusalError'
    this.code = code
  }
}
