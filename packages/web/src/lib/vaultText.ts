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
} as const satisfies Record<string, Pair>

export type VaultKey = keyof typeof VAULT_TEXT

export function vt(key: VaultKey, lang: Lang): string {
  return VAULT_TEXT[key][lang]
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
