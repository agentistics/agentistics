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
  /** SECRETS.4 §5.2: a process other than the agentop service asked to READ a secret. */
  | 'service-only'
  /** SECRETS.4 §5.2: the vault opens only inside the service, and no service answers. */
  | 'service-down'
  /** SECRETS.4 §5.3: the service could not make its memory private, so it opens nothing. */
  | 'hardening-failed'
  /** SECRETS.4 §3.5 / §2 — the presence and authenticator gate. */
  | 'presence-required'
  | 'stepup-required'
  | 'stepup-wrong'
  | 'stepup-clock'
  | 'stepup-replayed'
  | 'stepup-paused'
  | 'stepup-frozen'
  | 'auto-locked'
  /** §4.3: opened with the recovery key; only the three re-enrolment steps are allowed until done. */
  | 'recovery-mode'
  /** §4.3: the recovery key replaces the recovery passphrase where a protector exists. */
  | 'passphrase-replaced'

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
  /** The user's word for their presence gesture ("Windows Hello", "your security key"). */
  presence?: string
  /** Tries left before a pause. */
  left?: number
  /** "earlier" / "later" (already localized). */
  direction?: string
  /** A pause, already in words ("30 seconds"). */
  duration?: string
  /** The auto-lock period. */
  minutes?: number
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
  'service-only': () =>
    'This secret is used only inside the agentop service and is never handed to another program. Do this from the dashboard, or let the running service do it.',
  'service-down': () =>
    'The vault opens only inside the agentop service, and the service is not running. Start it (`agentop server`, or `agentop` → Services) and try again. Nothing was stored in plain text.',
  'hardening-failed': (a) =>
    `Agentistics could not make its own memory private (${a.reason ?? 'no reason given'}), so it will not open the vault in this process. Nothing was opened.`,
  'presence-required': (a) =>
    `The vault is locked. Confirm with ${a.presence ?? 'your personal confirmation'} to open it — no program can open it without you.`,
  'stepup-required': () => 'This needs your authenticator code.',
  'stepup-wrong': (a) => `That code is not right. ${a.left ?? 0} more tries before a pause.`,
  'stepup-clock': (a) => `That code is from ${a.n ?? 0} minutes ${a.direction ?? 'off'} — this computer's clock (or your phone's) is off. Fix the clock and try again.`,
  'stepup-replayed': () => 'That code was already used. Wait for the next one.',
  'stepup-paused': (a) => `Too many wrong codes. Try again in ${a.duration ?? 'a moment'}.`,
  'stepup-frozen': () => 'Too many wrong codes. The authenticator is frozen; open the vault with your 24-word recovery key (`agentop vault recover`) and set it up again.',
  'auto-locked': (a) => `The vault locked itself after ${a.minutes ?? 30} minutes without use. Confirm with ${a.presence ?? 'your personal confirmation'} to open it again.`,
  'recovery-mode': () => 'The vault was opened with the recovery key. Until you set up presence and the authenticator again and receive a new recovery key, nothing else can be done with it.',
  'passphrase-replaced': (a) => `This machine protects the vault with ${a.protector ?? 'its system keychain'}; the recovery key replaces the recovery passphrase.`,
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
  'service-only': () =>
    'Este segredo só é usado dentro do serviço do agentop e nunca é entregue a outro programa. Faça isto pelo painel, ou deixe o serviço em execução fazer.',
  'service-down': () =>
    'O cofre só abre dentro do serviço do agentop, e o serviço não está rodando. Inicie-o (`agentop server`, ou `agentop` → Serviços) e tente de novo. Nada foi guardado em texto puro.',
  'hardening-failed': (a) =>
    `O Agentistics não conseguiu tornar a própria memória privada (${a.reason ?? 'sem motivo informado'}), então não vai abrir o cofre neste processo. Nada foi aberto.`,
  'presence-required': (a) =>
    `O cofre está trancado. Confirme com ${a.presence ?? 'a sua confirmação pessoal'} para abri-lo — nenhum programa consegue abri-lo sem você.`,
  'stepup-required': () => 'Isto precisa do código do seu autenticador.',
  'stepup-wrong': (a) => `Esse código não está certo. Mais ${a.left ?? 0} tentativas antes de uma pausa.`,
  'stepup-clock': (a) => `Esse código é de ${a.n ?? 0} minutos ${a.direction ?? 'fora'} — o relógio deste computador (ou do seu celular) está errado. Acerte o relógio e tente de novo.`,
  'stepup-replayed': () => 'Esse código já foi usado. Espere o próximo.',
  'stepup-paused': (a) => `Códigos errados demais. Tente de novo em ${a.duration ?? 'instantes'}.`,
  'stepup-frozen': () => 'Códigos errados demais. O autenticador está congelado; abra o cofre com sua chave de recuperação de 24 palavras (`agentop vault recover`) e configure-o de novo.',
  'auto-locked': (a) => `O cofre se trancou sozinho depois de ${a.minutes ?? 30} minutos sem uso. Confirme com ${a.presence ?? 'a sua confirmação pessoal'} para abri-lo de novo.`,
  'recovery-mode': () => 'O cofre foi aberto com a chave de recuperação. Até você configurar de novo a confirmação pessoal e o autenticador e receber uma nova chave de recuperação, nada mais pode ser feito com ele.',
  'passphrase-replaced': (a) => `Esta máquina protege o cofre com ${a.protector ?? 'o chaveiro do sistema'}; a chave de recuperação substitui a frase-senha de recuperação.`,
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

// ── the first page enrolment's setup code (review S2) ────────────────────────────────────────────

/**
 * PURE. The exact command that mints the setup code for THIS service. The code lives in the running
 * service's memory and the CLI reaches it over `<data dir>/run/vault.sock`, so a service on a
 * non-default data dir (a preview, a second instance) is only reached with the same `AGENTISTICS_DIR`.
 */
export function setupCodeCommand(dataDir: string, defaultDir: string): string {
  if (dataDir === defaultDir) return 'agentop vault setup-code'
  const q = /^[\w./~@%+=:,-]+$/.test(dataDir) ? dataDir : `'${dataDir.replace(/'/g, `'\\''`)}'`
  return `AGENTISTICS_DIR=${q} agentop vault setup-code`
}

/**
 * PURE. WHERE the setup code can be shown, in plain words. It is printed only on a real terminal
 * (stdin and stdout both a TTY) — an assistant's chat, an IDE's output pane or a pipe is refused by
 * design — so a refusal that says only "a terminal" leaves the person running it in the very place
 * that cannot show it. Owner, 2026-10-02: ran it through an assistant's `!` prefix and got only that.
 */
export function setupCodeWhere(lang: Lang): string {
  return lang === 'pt'
    ? 'Abra o terminal do Ubuntu/WSL (ou o Terminal do macOS/Linux) e rode o comando lá. Dentro de um chat de assistente ou de uma IDE ele não aparece, por segurança.'
    : 'Open the Ubuntu/WSL terminal (or the Terminal on macOS/Linux) and run the command there. Inside an assistant\'s chat or an IDE it is not shown, for security.'
}

/** PURE. The CLI's / the socket's refusal when the setup code is asked for without a terminal. */
export function setupCodeTtyRefusal(lang: Lang, command = 'agentop vault setup-code'): string {
  return lang === 'pt'
    ? `O código de configuração só é mostrado num terminal de verdade. ${setupCodeWhere(lang)} Comando: ${command}`
    : `The setup code is shown only on a real terminal. ${setupCodeWhere(lang)} Command: ${command}`
}
