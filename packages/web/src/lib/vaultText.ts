/**
 * Words for Settings → Vault, in both languages, and the pure mapping from the server's codes.
 * One table, so a key cannot exist in one language only (`vaultText.test.ts` walks every entry).
 * The "how it works" copy says what docs/security.md §7a says, in plain words.
 */
export type Lang = 'en' | 'pt'
type Pair = { en: string; pt: string }

export const VAULT_TEXT = {
  title: { en: 'Vault', pt: 'Cofre' },
  intro: {
    en: 'Every secret Agentistics keeps on this machine is encrypted. This page shows what is sealed and in what state — never a value.',
    pt: 'Todo segredo que o Agentistics guarda nesta máquina é criptografado. Esta página mostra o que está cifrado e em que estado — nunca um valor.',
  },
  loading: { en: 'Reading the vault…', pt: 'Lendo o cofre…' },
  loadFailed: { en: 'Could not read the vault state from this machine.', pt: 'Não foi possível ler o estado do cofre nesta máquina.' },
  stateHeader: { en: 'Vault state', pt: 'Estado do cofre' },
  state: { en: 'State', pt: 'Estado' },
  protector: { en: 'Protected by', pt: 'Protegido por' },
  keyId: { en: 'Key id', pt: 'Id da chave' },
  created: { en: 'Created', pt: 'Criado em' },
  unknown: { en: 'unknown', pt: 'desconhecido' },
  none: { en: '—', pt: '—' },
  state_open: { en: 'Open', pt: 'Aberto' },
  state_locked: { en: 'Locked', pt: 'Travado' },
  state_uninitialized: { en: 'Not created yet', pt: 'Ainda não criado' },
  'state_protector-lost': { en: 'Protector unavailable', pt: 'Protetor indisponível' },
  state_corrupt: { en: 'Unreadable', pt: 'Ilegível' },
  secretsHeader: { en: 'Registered secrets', pt: 'Segredos registrados' },
  secretsEmpty: { en: 'No secret is stored on this machine yet.', pt: 'Nenhum segredo está guardado nesta máquina ainda.' },
  sealedAt: { en: 'Sealed', pt: 'Cifrado em' },
  howToReenter: { en: 'How to enter it again', pt: 'Como cadastrar de novo' },
  pendingTitle: { en: 'Waiting to be encrypted', pt: 'Aguardando criptografia' },
  pendingBody: {
    en: 'These still hold a secret in plain text from an earlier version. They are encrypted as soon as the vault can open; nothing new is written in plain text meanwhile.',
    pt: 'Estes ainda guardam um segredo em texto puro de uma versão anterior. São criptografados assim que o cofre puder abrir; enquanto isso, nada novo é gravado em texto puro.',
  },
  kind_github_backup: { en: 'GitHub token for backups', pt: 'Token do GitHub para backups' },
  kind_central_token: { en: 'Central connection tokens', pt: 'Tokens de conexão com a central' },
  kind_envelope_key: { en: 'Encrypted-channel key', pt: 'Chave do canal cifrado' },
  kind_central_env: { en: 'Central secrets', pt: 'Segredos do central' },
  kind_other: { en: 'Other secret', pt: 'Outro segredo' },
  itemState_sealed: { en: 'Sealed', pt: 'Cifrado' },
  itemState_pending: { en: 'Pending', pt: 'Pendente' },
  itemState_unreadable: { en: 'Unreadable', pt: 'Ilegível' },
  reason_plaintext: { en: 'still in plain text from an earlier version', pt: 'ainda em texto puro, de uma versão anterior' },
  'reason_wrong-machine': {
    en: 'sealed by another machine’s vault (a restored or copied file)',
    pt: 'cifrado pelo cofre de outra máquina (arquivo restaurado ou copiado)',
  },
  reason_unparseable: { en: 'the file is not a valid sealed file', pt: 'o arquivo não é um arquivo cifrado válido' },
  'reason_mode-open': {
    en: 'the file is readable by other users — treated as tampered',
    pt: 'o arquivo é legível por outros usuários — tratado como adulterado',
  },
  lockNow: { en: 'Lock now', pt: 'Travar agora' },
  locking: { en: 'Locking…', pt: 'Travando…' },
  lockHint: {
    en: 'Drops the key from memory. It opens again through the protector the next time a secret is needed.',
    pt: 'Tira a chave da memória. Ela abre de novo pelo protetor na próxima vez que um segredo for necessário.',
  },
  lockFailed: { en: 'Could not lock the vault.', pt: 'Não foi possível travar o cofre.' },
  howTitle: { en: 'How it works', pt: 'Como funciona' },
  how_envelope_h: { en: 'Envelope encryption', pt: 'Criptografia de envelope' },
  how_envelope: {
    en: 'One 32-byte key per machine seals every secret. Each purpose gets its own subkey, so a file sealed for one purpose cannot be opened as another. The cipher is AES-256-GCM, and each file is bound to its purpose, its name and this vault’s key id — copying one file over another fails.',
    pt: 'Uma chave de 32 bytes por máquina cifra todos os segredos. Cada finalidade tem a sua própria subchave, então um arquivo cifrado para uma finalidade não abre como outra. A cifra é AES-256-GCM, e cada arquivo fica preso à sua finalidade, ao seu nome e ao id da chave deste cofre — copiar um arquivo por cima de outro falha.',
  },
  how_holder_h: { en: 'Who holds the key', pt: 'Quem guarda a chave' },
  how_holder: {
    en: 'The key is never stored in the clear: the system protects it. macOS: the login Keychain. Windows: DPAPI for your account. WSL: Windows DPAPI through interop, then the system keyring, then a TPM. Linux: the system keyring (libsecret), then a TPM2. With none of these, a passphrase you choose.',
    pt: 'A chave nunca fica em claro: quem a protege é o sistema. macOS: o Keychain de login. Windows: DPAPI da sua conta. WSL: o DPAPI do Windows via interop, depois o chaveiro do sistema, depois um TPM. Linux: o chaveiro do sistema (libsecret), depois um TPM2. Sem nenhum deles, uma frase-senha escolhida por você.',
  },
  how_protects_h: { en: 'What it protects against', pt: 'Contra o que protege' },
  how_protects: {
    en: 'A copy of ~/.agentistics read somewhere else: a backup file, a synced folder that swept your home directory, a pendrive, a disk image, a laptop’s disk read from another system, a support bundle, a file pasted into a shared transcript. Each is a blob that opens only on this machine, under this account.',
    pt: 'Uma cópia de ~/.agentistics lida em outro lugar: um arquivo de backup, uma pasta sincronizada que levou seu diretório pessoal, um pendrive, uma imagem de disco, o disco de um notebook lido em outro sistema, um pacote de suporte, um arquivo colado em uma conversa compartilhada. Cada uma é um bloco que só abre nesta máquina, nesta conta.',
  },
  how_not_h: { en: 'What it does not protect against', pt: 'Contra o que não protege' },
  how_not: {
    en: 'A program running as you, on this machine, while the vault is open, can ask the protector for the key — as with every credential store on a desktop system. Malware with your account is out of scope.',
    pt: 'Um programa rodando como você, nesta máquina, enquanto o cofre está aberto, pode pedir a chave ao protetor — como em qualquer cofre de credenciais de um sistema desktop. Um malware com a sua conta está fora do escopo.',
  },
  how_backup_h: { en: 'Backups', pt: 'Backups' },
  how_backup: {
    en: 'A backup never carries the key, wrapped or not. A restored machine starts with no vault and creates a new one on first use; the secrets that were left out are entered again.',
    pt: 'O backup nunca leva a chave, nem cifrada. Uma máquina restaurada começa sem cofre e cria um novo no primeiro uso; os segredos que ficaram de fora são cadastrados de novo.',
  },

  // ── SECRETS.4 S4.8: unlock, step-up, the sections and the wizard ──────────────────────────────
  network: { en: 'Could not reach the Agentistics service on this machine.', pt: 'Não foi possível falar com o serviço do Agentistics nesta máquina.' },
  cancel: { en: 'Cancel', pt: 'Cancelar' },
  close: { en: 'Close', pt: 'Fechar' },
  working: { en: 'Working…', pt: 'Trabalhando…' },
  presenceWord_hello: { en: 'Windows Hello', pt: 'o Windows Hello' },
  presenceWord_fido2: { en: 'your security key', pt: 'sua chave de segurança' },
  presenceName_hello: { en: 'Windows Hello', pt: 'Windows Hello' },
  presenceName_fido2: { en: 'Security key', pt: 'Chave de segurança' },
  presenceWord_any: { en: 'your presence device', pt: 'seu dispositivo de presença' },
  lockedIntro_presence: {
    en: 'Your secrets are encrypted. Opening them needs {presence} and your authenticator code.',
    pt: 'Seus segredos estão criptografados. Abri-los exige {presence} e o código do seu autenticador.',
  },
  lockedIntro_code: {
    en: 'Your secrets are encrypted. Opening them needs your authenticator code.',
    pt: 'Seus segredos estão criptografados. Abri-los exige o código do seu autenticador.',
  },
  unlockWith_hello: { en: 'Unlock with Windows Hello', pt: 'Destravar com o Windows Hello' },
  unlockWith_fido2: { en: 'Unlock with your security key', pt: 'Destravar com a sua chave de segurança' },
  unlockPlain: { en: 'Unlock', pt: 'Destravar' },
  unlocking: { en: 'Waiting for you to confirm…', pt: 'Esperando a sua confirmação…' },
  codeLabel: { en: 'Authenticator code (6 digits)', pt: 'Código do autenticador (6 dígitos)' },
  codeConfirm: { en: 'Confirm', pt: 'Confirmar' },
  pendingCodeHint: {
    en: 'The key is ready. Type your code within 2 minutes — a wrong code locks it again.',
    pt: 'A chave está pronta. Digite o código em até 2 minutos — um código errado trava de novo.',
  },
  stepupTitle: { en: 'Confirm it is you', pt: 'Confirme que é você' },
  stepupBody: { en: 'The list of secrets needs your authenticator code.', pt: 'A lista de segredos exige o código do seu autenticador.' },
  openLocksIn: { en: 'Open · locks in {n} min', pt: 'Aberto · trava em {n} min' },
  sec_status: { en: 'Status', pt: 'Status' },
  gate_code: { en: 'Needs your authenticator code', pt: 'Exige o código do seu autenticador' },
  gate_presence: { en: 'Needs your presence (Windows Hello or security key)', pt: 'Exige a sua presença (Windows Hello ou chave de segurança)' },
  gate_dialog_code: { en: 'Type your current authenticator code to continue.', pt: 'Digite o código atual do seu autenticador para continuar.' },
  gate_dialog_presence: { en: '{presence} will ask you to confirm on the device.', pt: '{presence} vai pedir a sua confirmação no dispositivo.' },
  gate_continue: { en: 'Continue', pt: 'Continuar' },
  ultraTitle: { en: 'Make your vault ultra secure (2 min)', pt: 'Deixe o seu cofre ultra seguro (2 min)' },
  ultraBody: {
    en: 'Add an authenticator code, a 24-word recovery key and, where this machine has it, Windows Hello or a security key. Until then the vault keeps working exactly as before.',
    pt: 'Adicione um código de autenticador, uma chave de recuperação de 24 palavras e, onde esta máquina tiver, o Windows Hello ou uma chave de segurança. Até lá o cofre continua funcionando exatamente como antes.',
  },
  ultraRequired: { en: 'This is your main machine: this setup is required.', pt: 'Esta é a sua máquina principal: esta configuração é obrigatória.' },
  ultraStart: { en: 'Set up', pt: 'Configurar' },
  ultraLater: { en: 'Later', pt: 'Depois' },
  sec_authenticator: { en: 'Authenticator', pt: 'Autenticador' },
  auth_none: { en: 'Not set up yet.', pt: 'Ainda não configurado.' },
  auth_ready: { en: 'Set up on {date}', pt: 'Configurado em {date}' },
  auth_lastUsed: { en: 'Last used', pt: 'Último uso' },
  auth_never: { en: 'not used yet', pt: 'ainda não usado' },
  auth_paused: { en: 'Paused until {date} after wrong codes.', pt: 'Pausado até {date} depois de códigos errados.' },
  auth_frozen: {
    en: 'Frozen after too many wrong codes. Use your recovery key: run `agentop vault recover` on this machine.',
    pt: 'Congelado depois de muitos códigos errados. Use a chave de recuperação: rode `agentop vault recover` nesta máquina.',
  },
  auth_setup: { en: 'Set up authenticator', pt: 'Configurar o autenticador' },
  auth_replace: { en: 'Replace phone', pt: 'Trocar de celular' },
  sec_presence: { en: 'Presence', pt: 'Presença' },
  pres_unavailable: {
    en: 'Not available on this machine (no Windows Hello and no security-key support here). The vault stays on the system protector.',
    pt: 'Indisponível nesta máquina (sem Windows Hello e sem suporte a chave de segurança). O cofre fica no protetor do sistema.',
  },
  pres_addKey: { en: 'Add a security key', pt: 'Adicionar uma chave de segurança' },
  pres_turnOff: { en: 'Turn presence off', pt: 'Desligar a presença' },
  pres_offConsequence: {
    en: 'Any program running as you could open the vault without asking.',
    pt: 'Qualquer programa rodando como você poderia abrir o cofre sem perguntar.',
  },
  pres_offConfirm: { en: 'Turn presence off?', pt: 'Desligar a presença?' },
  pres_mainMachine: {
    en: 'This is your main machine: turning presence off needs your 24 words, typed on a terminal — run `agentop vault disable-presence`.',
    pt: 'Esta é a sua máquina principal: desligar a presença exige as suas 24 palavras, digitadas em um terminal — rode `agentop vault disable-presence`.',
  },
  pres_since: { en: 'enrolled {date}', pt: 'configurada em {date}' },
  sec_recovery: { en: 'Recovery key', pt: 'Chave de recuperação' },
  rec_created: { en: 'Created on {date}', pt: 'Criada em {date}' },
  sec_autolock: { en: 'Auto-lock', pt: 'Bloqueio automático' },
  auto_save: { en: 'Save', pt: 'Salvar' },
  auto_saved: { en: 'Saved.', pt: 'Salvo.' },
  auto_invalid: { en: 'Whole minutes from 5 to 480.', pt: 'Minutos inteiros de 5 a 480.' },
  hard_unknown: { en: 'Not reported by the service yet.', pt: 'O serviço ainda não informou.' },
  wiz_title: { en: 'Make your vault ultra secure', pt: 'Deixe o seu cofre ultra seguro' },
  wiz_step: { en: 'Step {i} of {n}', pt: 'Passo {i} de {n}' },
  wiz_safe: {
    en: 'Nothing is lost if you stop now: the vault keeps working as before until the last step.',
    pt: 'Nada se perde se você parar agora: o cofre continua funcionando como antes até o último passo.',
  },
  wiz_auth_title: { en: 'Set up your authenticator', pt: 'Configure o seu autenticador' },
  wiz_auth_intro: {
    en: 'An authenticator app (Google Authenticator, Authy, 1Password…) will show a 6-digit code every 30 seconds.',
    pt: 'Um app autenticador (Google Authenticator, Authy, 1Password…) mostra um código de 6 dígitos a cada 30 segundos.',
  },
  wiz_auth_show: { en: 'Show the QR code', pt: 'Mostrar o QR code' },
  wiz_auth_cant: { en: 'Can’t scan it?', pt: 'Não consegue escanear?' },
  wiz_auth_type: { en: 'Type this key into the app (“enter key manually”):', pt: 'Digite esta chave no app (“inserir chave manualmente”):' },
  wiz_rec_title: { en: 'Your recovery key', pt: 'Sua chave de recuperação' },
  wiz_rec_intro: {
    en: 'If you lose your phone or your device, these 24 words are the only way back in.',
    pt: 'Se você perder o celular ou o dispositivo, estas 24 palavras são o único caminho de volta.',
  },
  wiz_rec_show: { en: 'Show my 24 words', pt: 'Mostrar minhas 24 palavras' },
  wiz_rec_warn: {
    en: 'Keep it offline. Anyone with these words and this computer can open your vault.',
    pt: 'Guarde offline. Quem tiver estas palavras e este computador abre o seu cofre.',
  },
  wiz_rec_once: {
    en: 'Write them on paper. They are shown once and there is no copy button on purpose: copied text lands in the clipboard history.',
    pt: 'Escreva em papel. Elas são mostradas uma vez e não há botão de copiar de propósito: o texto copiado vai para o histórico da área de transferência.',
  },
  wiz_rec_print: { en: 'Print', pt: 'Imprimir' },
  wiz_rec_written: { en: 'I wrote them down', pt: 'Já anotei' },
  wiz_rec_confirmTitle: { en: 'Type three of the words', pt: 'Digite três das palavras' },
  wiz_rec_confirmBody: { en: 'To prove you have them, type the words at these positions.', pt: 'Para provar que você as tem, digite as palavras destas posições.' },
  wiz_rec_rotate: { en: 'The old recovery key stops working once you confirm this one.', pt: 'A chave de recuperação antiga deixa de funcionar quando você confirmar esta.' },
  wiz_word: { en: 'Word #{n}', pt: 'Palavra nº {n}' },
  wiz_pres_title: { en: 'Turn on presence', pt: 'Ligue a presença' },
  wiz_pres_checkHello: {
    en: 'Agentistics is checking that Windows Hello can protect your vault — confirm twice.',
    pt: 'O Agentistics está verificando se o Windows Hello pode proteger o seu cofre — confirme duas vezes.',
  },
  wiz_pres_checkKey: {
    en: 'Agentistics is checking that your security key can protect your vault — touch it twice.',
    pt: 'O Agentistics está verificando se a sua chave de segurança pode proteger o seu cofre — toque nela duas vezes.',
  },
  wiz_pres_go: { en: 'Turn on presence', pt: 'Ligar a presença' },
  wiz_next: { en: 'Next', pt: 'Próximo' },
  wiz_done: { en: 'Done', pt: 'Pronto' },
  wiz_done_presence: {
    en: 'From now on the vault opens only with {presence} and your code. It locks itself after {n} minutes without use. Keep your 24 words offline.',
    pt: 'A partir de agora o cofre só abre com {presence} e o seu código. Ele trava sozinho depois de {n} minutos sem uso. Guarde as suas 24 palavras offline.',
  },

  // ── owner feedback 2026-10-02: plain words, one code, every step in one go ────────────────────
  pres_off: {
    en: 'Off. Today the vault opens by itself when Agentistics starts, without asking for your fingerprint or PIN.',
    pt: 'Desligada. Hoje o cofre abre sozinho quando o agentistics liga, sem pedir sua digital/PIN.',
  },
  pres_turnOn: { en: 'Require Windows Hello', pt: 'Exigir Windows Hello' },
  pres_turnOnKey: { en: 'Require a security key', pt: 'Exigir chave de segurança' },
  rec_none: { en: 'No recovery key yet.', pt: 'Ainda não há chave de recuperação.' },
  rec_create: { en: 'Create recovery key', pt: 'Criar chave de recuperação' },
  rec_new: { en: 'Make a new one (the old one stops working)', pt: 'Gerar uma nova (a antiga para de valer)' },
  rec_lost: {
    en: 'Lost your phone and Windows Hello? Run `agentop vault recover` in a terminal on this machine and type the 24 words.',
    pt: 'Perdeu o celular e o Windows Hello? Rode `agentop vault recover` num terminal desta máquina e digite as 24 palavras.',
  },
  sec_hardening: { en: 'Memory protection', pt: 'Proteção da memória' },
  hard_plain1: { en: 'Other programs cannot read Agentistics’ memory', pt: 'Outros programas não conseguem ler a memória do agentistics' },
  hard_plain2: { en: 'If it crashes, no secret ends up in a file', pt: 'Se ele travar, nenhum segredo vai parar em arquivo' },
  hard_bad: { en: 'Memory protection is NOT fully active on this machine — see the technical details.', pt: 'A proteção da memória NÃO está totalmente ativa nesta máquina — veja os detalhes técnicos.' },
  hard_details: { en: 'technical details', pt: 'detalhes técnicos' },
  hard_tech_private: { en: 'process memory is private (non-dumpable): {v}', pt: 'a memória do processo é privada (não-despejável): {v}' },
  hard_tech_core: { en: 'core dumps: {v}', pt: 'core dumps: {v}' },
  auto_before: { en: 'Lock by itself after', pt: 'Trancar sozinho depois de' },
  auto_after: { en: 'minutes without use (5–480)', pt: 'minutos sem uso (5–480)' },
  auto_hint: { en: 'There is no “never”.', pt: 'Não existe “nunca”.' },
  auth_explain: {
    en: 'The app’s code is asked to open the vault and to change these settings.',
    pt: 'O código do app é pedido para abrir o cofre e para mudar estas configurações.',
  },
  tip_asks: { en: 'Will ask for: {what}', pt: 'Vai pedir: {what}' },
  tip_code: { en: 'your authenticator code', pt: 'o código do seu autenticador' },
  tip_presence: { en: '{presence} on this computer', pt: '{presence} neste computador' },
  tip_and: { en: ' and ', pt: ' e ' },
  tip_nothing: { en: 'Nothing more is asked.', pt: 'Nada mais é pedido.' },
  wiz_auth_scan: { en: 'Scan this, then type the 6-digit code the app shows now.', pt: 'Escaneie, depois digite o código de 6 dígitos que o app mostra agora.' },
  wiz_auth_once: { en: 'This QR code is shown once.', pt: 'Este QR code é mostrado uma vez.' },
  wiz_code: { en: 'Code from the app', pt: 'Código do app' },
  wiz_oldCode: { en: 'Type the current code from your authenticator to continue.', pt: 'Digite o código atual do seu autenticador para continuar.' },
  wiz_probe_title: { en: 'First, check your device', pt: 'Primeiro, vamos testar o seu dispositivo' },
  wiz_probe_intro: {
    en: 'Before changing anything we make sure {presence} works with the vault. Nothing is changed by this test.',
    pt: 'Antes de mudar qualquer coisa, conferimos se {presence} funciona com o cofre. Este teste não muda nada.',
  },
  wiz_probe_go: { en: 'Test it', pt: 'Testar' },
  wiz_failedAt: { en: 'It stopped at: {step}. Nothing before it was lost — try again to resume from there.', pt: 'Parou em: {step}. O que veio antes foi mantido — tente de novo para continuar daqui.' },
  wiz_step_probe: { en: 'device check', pt: 'teste do dispositivo' },
  wiz_step_authenticator: { en: 'authenticator', pt: 'autenticador' },
  wiz_step_recovery: { en: 'recovery key', pt: 'chave de recuperação' },
  wiz_step_presence: { en: 'presence', pt: 'presença' },
  wiz_pres_intro: {
    en: 'From now on the vault opens only with your gesture. The silent system wrapper is removed — after the new one is checked.',
    pt: 'A partir de agora o cofre só abre com um gesto seu. O invólucro silencioso do sistema é removido — depois que o novo for conferido.',
  },
  wiz_done_plain: {
    en: 'Your authenticator and recovery key are set up. The vault locks itself after {n} minutes without use. Keep your 24 words offline.',
    pt: 'O autenticador e a chave de recuperação estão configurados. O cofre trava sozinho depois de {n} minutos sem uso. Guarde as suas 24 palavras offline.',
  },
} as const satisfies Record<string, Pair>

export type VaultKey = keyof typeof VAULT_TEXT

export function vt(key: VaultKey, lang: Lang): string {
  return VAULT_TEXT[key][lang]
}

/** `vt` with `{name}` placeholders filled — the only interpolation the table uses. */
export function vtf(key: VaultKey, lang: Lang, vars: Record<string, string | number>): string {
  return VAULT_TEXT[key][lang].replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''))
}

/** The user's word for their presence gesture, from the wrapper kinds the vault holds. */
export function presenceKey(wrappers: readonly string[]): VaultKey {
  return wrappers.includes('hello') ? 'presenceWord_hello' : wrappers.includes('fido2') ? 'presenceWord_fido2' : 'presenceWord_any'
}

/** The server's codes (kind / state / reason) → the table's keys. Unknown codes fall back safely. */
export function kindKey(kind: string): VaultKey {
  const k = `kind_${kind.replace(/-/g, '_')}` as VaultKey
  return k in VAULT_TEXT ? k : 'kind_other'
}
export function stateKey(state: string): VaultKey {
  const k = `state_${state}` as VaultKey
  return k in VAULT_TEXT ? k : 'state_corrupt'
}
export function itemStateKey(state: string): VaultKey {
  const k = `itemState_${state}` as VaultKey
  return k in VAULT_TEXT ? k : 'itemState_unreadable'
}
export function reasonKey(reason: string | undefined): VaultKey | null {
  if (!reason) return null
  const k = `reason_${reason}` as VaultKey
  return k in VAULT_TEXT ? k : null
}

/** Pending items first: the ones that need attention lead the list. */
export function orderItems<T extends { state: string }>(items: T[]): T[] {
  const rank = (s: string) => (s === 'pending' ? 0 : s === 'unreadable' ? 1 : 2)
  return [...items].sort((a, b) => rank(a.state) - rank(b.state))
}
