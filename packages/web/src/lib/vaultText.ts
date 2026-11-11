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
  secretsOnVault: { en: '{n} secret(s) kept by Agentistics itself. They are listed with yours on the Vault page, under "System" — names, files, dates and states, never a value.', pt: '{n} segredo(s) guardado(s) pelo próprio Agentistics. Eles aparecem junto com os seus na página Cofre, em "Do sistema" — nome, arquivo, data e estado, nunca o valor.' },
  secretsOpenVault: { en: 'See them in the Vault', pt: 'Ver no Cofre' },
  sealedAt: { en: 'Sealed', pt: 'Cifrado em' },
  howToReenter: { en: 'How to enter it again', pt: 'Como cadastrar de novo' },
  pendingTitle: { en: 'Waiting to be encrypted', pt: 'Aguardando criptografia' },
  pendingBody: {
    en: 'These still hold a secret in plain text from an earlier version. They are encrypted as soon as the vault can open; nothing new is written in plain text meanwhile.',
    pt: 'Estes ainda guardam um segredo em texto puro de uma versão anterior. São criptografados assim que o cofre puder abrir; enquanto isso, nada novo é gravado em texto puro.',
  },
  kind_github_backup: { en: 'GitHub token for backups', pt: 'Token do GitHub para backups' },
  kind_envelope_key: { en: 'Encrypted-channel key', pt: 'Chave do canal cifrado' },
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
    en: 'A backup carries the vault as ONE sealed bundle: the secrets still encrypted, and the key only wrapped under your 24 words — nothing tied to this computer. On another machine, the restore brings it back and the 24 words open it; without them it opens nothing.',
    pt: 'O backup leva o cofre como UM pacote selado: os segredos ainda criptografados e a chave só embrulhada nas suas 24 palavras — nada preso a este computador. Em outra máquina, a restauração traz o pacote e as 24 palavras o abrem; sem elas, ele não abre nada.',
  },

  // ── SECRETS.4 S4.8: unlock, step-up, the sections and the wizard ──────────────────────────────
  network: { en: 'Could not reach the Agentistics service on this machine.', pt: 'Não foi possível falar com o serviço do Agentistics nesta máquina.' },
  cancel: { en: 'Cancel', pt: 'Cancelar' },
  close: { en: 'Close', pt: 'Fechar' },
  working: { en: 'Working…', pt: 'Trabalhando…' },
  presenceWord_hello: { en: 'Windows Hello', pt: 'o Windows Hello' },
  presenceWord_fido2: { en: 'your security key', pt: 'sua chave de segurança' },
  presenceWord_touchid: { en: 'Touch ID (or the Mac password)', pt: 'o Touch ID (ou a senha do Mac)' },
  presenceWord_password: { en: 'the vault password', pt: 'a senha do cofre' },
  presenceName_hello: { en: 'Windows Hello', pt: 'Windows Hello' },
  presenceName_fido2: { en: 'Security key', pt: 'Chave de segurança' },
  presenceName_touchid: { en: 'Touch ID or the Mac password', pt: 'Touch ID ou senha do Mac' },
  presenceName_password: { en: 'A vault password of your own', pt: 'Uma senha própria do cofre' },
  presenceWord_any: { en: 'your personal confirmation', pt: 'a sua confirmação pessoal' },
  lockedIntro_presence: {
    en: 'Your secrets are encrypted. Opening them needs {presence}.',
    pt: 'Seus segredos estão criptografados. Abri-los exige {presence}.',
  },
  // The lock screen's one sentence names the way THIS machine's vault really confirms: the wrappers the
  // service reports (Touch ID / the Mac password, Windows Hello, a key, the vault password). Never a
  // hardcoded brand. (COFRE.DESBLOQUEIO: no app code anywhere.)
  lockedSub_hello: { en: 'Your secrets are protected. Unlock with Windows Hello.', pt: 'Seus segredos estão protegidos. Destrave com o Windows Hello.' },
  lockedSub_fido2: { en: 'Your secrets are protected. Unlock with your security key.', pt: 'Seus segredos estão protegidos. Destrave com a sua chave de segurança.' },
  lockedSub_touchid: { en: 'Your secrets are protected. Unlock with Touch ID or the Mac password.', pt: 'Seus segredos estão protegidos. Destrave com o Touch ID ou a senha do Mac.' },
  lockedSub_password: { en: 'Your secrets are protected. Unlock with the vault password.', pt: 'Seus segredos estão protegidos. Destrave com a senha do cofre.' },
  lockedSub_plain: { en: 'Your secrets are protected.', pt: 'Seus segredos estão protegidos.' },
  unlockWith_hello: { en: 'Unlock with Windows Hello', pt: 'Destravar com o Windows Hello' },
  unlockWith_fido2: { en: 'Unlock with your security key', pt: 'Destravar com a sua chave de segurança' },
  unlockWith_touchid: { en: 'Unlock with Touch ID', pt: 'Destravar com o Touch ID' },
  unlockWith_password: { en: 'Unlock', pt: 'Destravar' },
  createVault: { en: 'Create the vault', pt: 'Criar o cofre' },
  createVaultHint: { en: 'There is no vault on this computer yet. Creating one takes a moment and protects it with this computer\'s own keychain.', pt: 'Ainda não há um cofre neste computador. Criar leva um instante e o protege com o chaveiro do próprio computador.' },
  createVaultPassHint: { en: 'No system keychain is available here, so protect the vault with a passphrase. Write it down — it cannot be recovered.', pt: 'Não há chaveiro do sistema disponível aqui, então proteja o cofre com uma senha. Anote-a — ela não pode ser recuperada.' },
  createVaultPassLabel: { en: 'Passphrase', pt: 'Senha' },
  createVaultCreating: { en: 'Creating…', pt: 'Criando…' },
  unlockPlain: { en: 'Unlock', pt: 'Destravar' },
  unlocking: { en: 'Waiting for you to confirm…', pt: 'Esperando a sua confirmação…' },
  codeConfirm: { en: 'Confirm', pt: 'Confirmar' },
  stepupTitle: { en: 'Confirm it is you', pt: 'Confirme que é você' },
  openLocksIn: { en: 'Open · locks in {n} min', pt: 'Aberto · trava em {n} min' },
  sec_status: { en: 'Status', pt: 'Status' },
  gate_presence: { en: 'Asks you to confirm it is you', pt: 'Pede que você confirme que é você' },
  gate_dialog_presence: { en: '{presence} will ask you to confirm.', pt: '{presence} vai pedir a sua confirmação.' },
  gate_continue: { en: 'Continue', pt: 'Continuar' },
  ultraTitle: { en: 'Protect your vault (1 min)', pt: 'Proteja o seu cofre (1 min)' },
  ultraBody: {
    en: 'Choose how the vault confirms it is you — what this computer already has (Touch ID or the Mac password, Windows Hello) or a vault password of your own — and keep the 24-word recovery key. Until then the vault keeps working exactly as before.',
    pt: 'Escolha como o cofre confirma que é você — o que este computador já tem (Touch ID ou senha do Mac, Windows Hello) ou uma senha própria do cofre — e guarde a chave de recuperação de 24 palavras. Até lá o cofre continua funcionando exatamente como antes.',
  },
  ultraRequired: { en: 'This is your main machine: this setup is required.', pt: 'Esta é a sua máquina principal: esta configuração é obrigatória.' },
  ultraStart: { en: 'Set up', pt: 'Configurar' },
  ultraLater: { en: 'Later', pt: 'Depois' },
  sec_presence: { en: 'How the vault confirms it is you', pt: 'Como o cofre confirma que é você' },
  pres_unavailable: {
    en: 'No way to confirm is available on this machine. The vault stays on the system protector.',
    pt: 'Nenhuma forma de confirmação está disponível nesta máquina. O cofre fica no protetor do sistema.',
  },
  legacy_code_note: {
    en: 'This vault used to also ask a 6-digit app code. That is gone: it is no longer asked anywhere, and its record is removed as soon as you choose a way to confirm below.',
    pt: 'Este cofre também pedia um código de 6 dígitos de aplicativo. Isso acabou: ele não é mais pedido em lugar nenhum, e o registro dele é apagado assim que você escolher uma forma de confirmação abaixo.',
  },
  pres_addKey: { en: 'Add a security key', pt: 'Adicionar uma chave de segurança' },
  pres_turnOff: { en: 'Turn personal confirmation off', pt: 'Desligar a confirmação pessoal' },
  pres_offConsequence: {
    en: 'Any program running as you could open the vault without asking.',
    pt: 'Qualquer programa rodando como você poderia abrir o cofre sem perguntar.',
  },
  pres_offConfirm: { en: 'Turn personal confirmation off?', pt: 'Desligar a confirmação pessoal?' },
  pres_mainMachine: {
    en: 'This is your main machine: turning personal confirmation off also asks for your 24 words, typed on this page on this computer.',
    pt: 'Esta é a sua máquina principal: desligar a confirmação pessoal também pede as suas 24 palavras, digitadas nesta página, no próprio computador.',
  },
  pres_since: { en: 'enrolled {date}', pt: 'configurada em {date}' },
  sec_recovery: { en: 'Recovery key', pt: 'Chave de recuperação' },
  rec_created: { en: 'Created on {date}', pt: 'Criada em {date}' },
  sec_autolock: { en: 'Auto-lock', pt: 'Bloqueio automático' },
  auto_save: { en: 'Save', pt: 'Salvar' },
  auto_saved: { en: 'Saved.', pt: 'Salvo.' },
  auto_invalid: { en: 'Whole minutes from 5 to 480.', pt: 'Minutos inteiros de 5 a 480.' },
  hard_unknown: { en: 'Not reported by the service yet.', pt: 'O serviço ainda não informou.' },
  wiz_title: { en: 'Protect your vault', pt: 'Proteger o cofre' },
  wiz_step: { en: 'Step {i} of {n}', pt: 'Passo {i} de {n}' },
  wiz_safe: {
    en: 'Nothing is lost if you stop now: the vault keeps working as before until the last step.',
    pt: 'Nada se perde se você parar agora: o cofre continua funcionando como antes até o último passo.',
  },
  wiz_rec_title: { en: 'Your recovery key', pt: 'Sua chave de recuperação' },
  wiz_rec_intro: {
    en: 'If you forget your password or lose your device, these 24 words are the only way back in.',
    pt: 'Se você esquecer a senha ou perder o dispositivo, estas 24 palavras são o único caminho de volta.',
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
  wiz_pres_title: { en: 'Choose how the vault confirms it is you', pt: 'Escolha como o cofre confirma que é você' },
  wiz_method_touchid_d: { en: 'Your fingerprint, or this Mac\'s login password. Nothing to install.', pt: 'Sua digital, ou a senha de login deste Mac. Nada para instalar.' },
  wiz_method_hello_d: { en: 'Your PIN, fingerprint or face, as Windows asks.', pt: 'Seu PIN, digital ou rosto, como o Windows pede.' },
  wiz_method_password_d: { en: 'A password only you know. Works on any computer.', pt: 'Uma senha que só você sabe. Funciona em qualquer computador.' },
  wiz_method_fido2_d: { en: 'A USB/NFC key you touch (YubiKey and similar).', pt: 'Uma chave USB/NFC que você toca (YubiKey e parecidas).' },
  wiz_method_recommended: { en: 'recommended', pt: 'recomendado' },
  wiz_method_advanced: { en: 'Advanced', pt: 'Avançado' },
  wiz_pres_enrolTouchid: {
    en: 'macOS will ask for Touch ID or the Mac password once. After that, each unlock asks once.',
    pt: 'O macOS vai pedir o Touch ID ou a senha do Mac uma vez. Depois disso, cada abertura pede uma vez.',
  },
  wiz_pw_label: { en: 'Vault password', pt: 'Senha do cofre' },
  wiz_pw_again: { en: 'Type it again', pt: 'Digite de novo' },
  wiz_pw_mismatch: { en: 'The two do not match yet.', pt: 'As duas ainda não conferem.' },
  wiz_pw_generate: { en: 'Generate a random password', pt: 'Gerar senha aleatória' },
  wiz_pw_generated: { en: 'Your new password — store it in your password manager now. It is shown only here, once.', pt: 'Sua senha nova — guarde no seu gerenciador de senhas agora. Ela aparece só aqui, uma vez.' },
  wiz_pw_copy: { en: 'Copy', pt: 'Copiar' },
  wiz_pw_copied: { en: 'Copied', pt: 'Copiado' },
  wiz_pw_go: { en: 'Protect with this password', pt: 'Proteger com esta senha' },
  wiz_pw_how_title: { en: 'How your password is protected', pt: 'Como sua senha fica protegida' },
  wiz_pw_how_1: {
    en: 'It is never stored — not on disk, not in the browser. It travels once, to Agentistics on this computer.',
    pt: 'Ela nunca é guardada — nem no disco, nem no navegador. Ela vai uma vez, só para o Agentistics neste computador.',
  },
  wiz_pw_how_2: {
    en: 'There it goes through scrypt with a random salt (a slow, memory-hard derivation) to make the key that opens the vault, and is then dropped from memory.',
    pt: 'Lá ela passa pelo scrypt com um sal aleatório (uma derivação lenta e que gasta memória) para gerar a chave que abre o cofre, e depois é descartada da memória.',
  },
  wiz_pw_how_3: {
    en: 'Each wrong try costs time on purpose; after five, it waits before accepting more.',
    pt: 'Cada tentativa errada custa tempo de propósito; depois de cinco, ele espera antes de aceitar outras.',
  },
  wiz_pw_how_4: {
    en: 'Forgot it? Nobody can reset it — your 24 recovery words open the vault.',
    pt: 'Esqueceu? Ninguém consegue redefinir — as suas 24 palavras de recuperação abrem o cofre.',
  },
  pw_prompt_title: { en: 'Type the vault password', pt: 'Digite a senha do cofre' },
  pw_prompt_body: { en: 'This needs you to confirm it is you.', pt: 'Isto precisa que você confirme que é você.' },
  pw_prompt_wrong: { en: 'That is not the vault password. Try again.', pt: 'Essa não é a senha do cofre. Tente de novo.' },
  pw_prompt_go: { en: 'Confirm', pt: 'Confirmar' },
  pw_forgot: { en: 'Forgot it? Use “Recover with the 24 words”.', pt: 'Esqueceu? Use “Recuperar com as 24 palavras”.' },
  wiz_pres_checkHello: {
    en: 'Agentistics checks that Windows Hello is set up on this computer. This check asks you nothing.',
    pt: 'O Agentistics confere se o Windows Hello está configurado neste computador. Este teste não pede nada a você.',
  },
  wiz_pres_checkKey: {
    en: 'Agentistics checks that your security key is plugged in and can protect the vault. This check asks for no touch.',
    pt: 'O Agentistics confere se a sua chave de segurança está conectada e pode proteger o cofre. Este teste não pede toque.',
  },
  wiz_pres_enrolHello: {
    en: 'Windows Hello will ask you {n} times: once to create the vault\'s key, once to use it. After that, each unlock asks once.',
    pt: 'O Windows Hello vai pedir {n} vezes: uma para criar a chave do cofre e uma para usá-la. Depois disso, cada abertura pede uma vez.',
  },
  wiz_pres_enrolKey: {
    en: 'Touch your key {n} times: once to register it, once to use it. After that, each unlock asks once.',
    pt: 'Toque na chave {n} vezes: uma para registrá-la e uma para usá-la. Depois disso, cada abertura pede uma vez.',
  },
  wiz_pres_heldNote: {
    en: 'Nothing in your vault changes until you confirm the recovery key, in the last step. Leaving before that keeps everything as it is now.',
    pt: 'Nada no seu cofre muda até você confirmar a chave de recuperação, no último passo. Se sair antes disso, tudo fica como está agora.',
  },
  wiz_gesture_progress: { en: 'Confirmation {i} of {n}', pt: 'Confirmação {i} de {n}' },
  wiz_pres_go: { en: 'Continue', pt: 'Continuar' },
  wiz_next: { en: 'Next', pt: 'Próximo' },
  wiz_done: { en: 'Done', pt: 'Pronto' },
  wiz_done_presence: {
    en: 'From now on the vault opens only with {presence}. It locks itself after {n} minutes without use. Keep your 24 words offline.',
    pt: 'A partir de agora o cofre só abre com {presence}. Ele trava sozinho depois de {n} minutos sem uso. Guarde as suas 24 palavras offline.',
  },

  // ── owner feedback 2026-10-02: plain words, one code, every step in one go ────────────────────
  pres_off: {
    en: 'Not chosen yet. Today the vault opens by itself when Agentistics starts, without asking you anything.',
    pt: 'Ainda não escolhida. Hoje o cofre abre sozinho quando o Agentistics liga, sem pedir nada a você.',
  },
  pres_turnOn: { en: 'Choose how it confirms', pt: 'Escolher como confirma' },
  rec_none: { en: 'No recovery key yet.', pt: 'Ainda não há chave de recuperação.' },
  rec_create: { en: 'Create recovery key', pt: 'Criar chave de recuperação' },
  rec_new: { en: 'Make a new one (the old one stops working)', pt: 'Gerar uma nova (a antiga para de valer)' },
  rec_lost: {
    en: 'Forgot the password or lost your device? Use "Recover with the 24 words" on this page, opened on this computer.',
    pt: 'Esqueceu a senha ou perdeu o dispositivo? Use “Recuperar com as 24 palavras” nesta página, aberta no próprio computador.',
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
  tip_asks: { en: 'Will ask for: {what}', pt: 'Vai pedir: {what}' },
  tip_code: { en: 'a confirmation', pt: 'uma confirmação' },
  tip_presence: { en: '{presence} on this computer', pt: '{presence} neste computador' },
  tip_and: { en: ' and ', pt: ' e ' },
  tip_nothing: { en: 'Nothing more is asked.', pt: 'Nada mais é pedido.' },
  wiz_setup_label: { en: 'Setup code (8 digits)', pt: 'Código de configuração (8 dígitos)' },
  wiz_pres_newWords: { en: 'Continue and make new recovery words', pt: 'Continuar e criar palavras de recuperação novas' },
  wiz_pres_newWords_warn: {
    en: 'Your current 24 words will stop working: choosing how the vault confirms replaces its key. New words are made right after.',
    pt: 'As suas 24 palavras atuais deixarão de funcionar: escolher como o cofre confirma troca a chave dele. Palavras novas são criadas logo em seguida.',
  },
  wiz_setup_why: {
    en: 'The first setup from this page needs a code only this computer can show: run `agentop vault setup-code` in a terminal here. It works once, for 10 minutes.',
    pt: 'A primeira configuração por esta página precisa de um código que só este computador mostra: rode `agentop vault setup-code` num terminal aqui. Vale uma vez, por 10 minutos.',
  },
  wiz_setup_title: { en: 'First, confirm you are at this computer', pt: 'Primeiro, confirme que você está neste computador' },
  wiz_setup_intro: {
    en: 'Setting up the vault from a page for the first time needs a code that only this computer shows. It proves the request comes from you, not from some other page. Nothing else is asked until this is done.',
    pt: 'A primeira configuração do cofre por uma página precisa de um código que só este computador mostra. Ele prova que o pedido vem de você, e não de outra página. Nada mais é pedido antes disso.',
  },
  wiz_setup_run: { en: 'Run this command:', pt: 'Rode este comando:' },
  wiz_setup_valid: { en: 'It prints an 8-digit code that works once, for 10 minutes.', pt: 'Ele mostra um código de 8 dígitos que vale uma vez, por 10 minutos.' },
  wiz_setup_go: { en: 'Continue', pt: 'Continuar' },
  wiz_probe_title: { en: 'First, check your device', pt: 'Primeiro, vamos testar o seu dispositivo' },
  wiz_probe_intro: {
    en: 'Before changing anything we make sure {presence} works with the vault. Nothing is changed by this test.',
    pt: 'Antes de mudar qualquer coisa, conferimos se {presence} funciona com o cofre. Este teste não muda nada.',
  },
  wiz_probe_go: { en: 'Test it', pt: 'Testar' },
  wiz_failedAt: { en: 'It stopped at: {step}. Nothing before it was lost — try again to resume from there.', pt: 'Parou em: {step}. O que veio antes foi mantido — tente de novo para continuar daqui.' },
  wiz_step_setup: { en: 'setup code', pt: 'código de configuração' },
  wiz_step_probe: { en: 'device check', pt: 'teste do dispositivo' },
  wiz_step_recovery: { en: 'recovery key', pt: 'chave de recuperação' },
  wiz_step_presence: { en: 'how it confirms', pt: 'como confirma' },
  wiz_pres_intro: {
    en: 'From now on the vault opens only after you confirm it is you. Nothing changes in it until the last step.',
    pt: 'A partir de agora o cofre só abre depois que você confirmar que é você. Nada muda nele até o último passo.',
  },
  wiz_done_plain: {
    en: 'Your recovery key is set up. The vault locks itself after {n} minutes without use. Keep your 24 words offline.',
    pt: 'A chave de recuperação está configurada. O cofre trava sozinho depois de {n} minutos sem uso. Guarde as suas 24 palavras offline.',
  },

  // ── VAULT.UX2: a header that explains itself, a badge and a reason per section ────────────────
  how_title: { en: 'How your vault works', pt: 'Como o seu cofre funciona' },
  how1_t: { en: 'Locked', pt: 'Trancado' },
  how1_b: { en: 'Your secrets are encrypted and nobody can read them.', pt: 'Seus segredos ficam criptografados e ninguém consegue lê-los.' },
  how2_t: { en: 'You confirm it is you', pt: 'Você confirma que é você' },
  how2_proof: { en: '{presence} — once to open, and again for anything sensitive.', pt: '{presence} — uma vez para abrir e de novo para o que for sensível.' },
  how2_nothing: { en: 'Nothing yet: it opens by itself. Set it up below to require your confirmation.', pt: 'Nada ainda: ele abre sozinho. Configure abaixo para exigir a sua confirmação.' },
  how3_t: { en: 'Open for {n} min', pt: 'Aberto por {n} min' },
  how3_b: { en: 'It locks again by itself when you stop using it.', pt: 'Ele tranca de novo sozinho quando você para de usar.' },
  how_here: { en: 'You are here', pt: 'Você está aqui' },
  hero_locked: { en: 'Your vault is locked', pt: 'Seu cofre está trancado' },
  sec_status_d: { en: 'Whether your secrets can be read right now, and who guards the key.', pt: 'Se os seus segredos podem ser lidos agora e quem guarda a chave.' },
  sec_presence_d: {
    en: 'Touch ID or the Mac password, Windows Hello, a vault password of your own, or a security key: proves it is really you.',
    pt: 'Touch ID ou senha do Mac, Windows Hello, uma senha própria do cofre ou uma chave de segurança: prova que é você mesmo.',
  },
  sec_recovery_d: { en: 'Your way back in if you forget the password or lose your device: 24 words, shown once.', pt: 'Seu caminho de volta se você esquecer a senha ou perder o dispositivo: 24 palavras, mostradas uma vez.' },
  rec_offline: { en: 'Keep it offline — on paper, never in a file or a photo.', pt: 'Guarde offline — no papel, nunca em arquivo ou foto.' },
  cfu_title: { en: 'Confirm each use', pt: 'Confirmar cada uso' },
  cfu_d: { en: 'When an agent wants to use a sensitive secret, you approve that use first. Off: granted secrets are used without asking.', pt: 'Quando um agente quer usar um segredo sensível, você aprova esse uso antes. Desligado: os segredos liberados são usados sem perguntar.' },
  sec_autolock_d: { en: 'The vault locks itself when you are away, so it is never left open.', pt: 'O cofre tranca sozinho quando você se afasta, para nunca ficar aberto.' },
  sec_memory_d: { en: 'How Agentistics keeps the key out of reach of other programs while the vault is open.', pt: 'Como o Agentistics mantém a chave fora do alcance de outros programas enquanto o cofre está aberto.' },
  sec_secrets_d: { en: 'What is stored in the vault. You see names and dates — never the values.', pt: 'O que está guardado no cofre. Você vê nomes e datas — nunca os valores.' },
  badge_configured: { en: '✓ Configured', pt: '✓ Configurado' },
  badge_missing: { en: '! Missing', pt: '! Falta' },
  badge_recommended: { en: 'Recommended', pt: 'Recomendado' },
  badge_on: { en: '✓ On', pt: '✓ Ligada' },
  badge_na: { en: 'Not available here', pt: 'Indisponível aqui' },
  badge_attention: { en: '! Needs attention', pt: '! Pede atenção' },
  badge_active: { en: '✓ Active', pt: '✓ Ativa' },
  badge_limited: { en: 'Limited on this system', pt: 'Limitada neste sistema' },
  badge_minutes: { en: '✓ {n} min', pt: '✓ {n} min' },
  badge_sealed: { en: '✓ {n} sealed', pt: '✓ {n} cifrados' },
  badge_pending: { en: '! {n} waiting', pt: '! {n} aguardando' },

  // ── v2.98.1: a second kind, "coming soon", the local gesture, recovery on the page ──────────────
  pres_addOther: { en: 'Add another way', pt: 'Adicionar outra forma' },
  pres_add_hello: { en: 'Add Windows Hello', pt: 'Adicionar Windows Hello' },
  pres_add_fido2: { en: 'Add a security key', pt: 'Adicionar uma chave de segurança' },
  pres_add_touchid: { en: 'Add Touch ID', pt: 'Adicionar Touch ID' },
  pres_add_password: { en: 'Add a vault password', pt: 'Adicionar uma senha do cofre' },
  pres_soon: { en: 'coming soon', pt: 'em breve' },
  pres_soon_fido2: {
    en: 'Security keys through Windows are not ready yet. Windows Hello does the same job today.',
    pt: 'A chave de segurança pelo Windows ainda não está pronta. O Windows Hello faz o mesmo papel hoje.',
  },
  wiz_step_local: { en: 'confirm it is you', pt: 'confirmar que é você' },
  wiz_local_title: { en: 'First, confirm it is you', pt: 'Primeiro, confirme que é você' },
  wiz_local_intro: {
    en: 'This page is open on this computer, so one confirmation is enough to prove the setup comes from you and not from some other page. Nothing in the vault changes with it.',
    pt: 'Esta página está aberta no próprio computador, então uma confirmação basta para provar que a configuração vem de você, e não de outra página. Nada no cofre muda com ela.',
  },
  wiz_local_go_hello: { en: 'Confirm with Windows Hello', pt: 'Confirmar com o Windows Hello' },
  wiz_local_go_fido2: { en: 'Confirm with your security key', pt: 'Confirmar com a chave de segurança' },
  wiz_local_go_touchid: { en: 'Confirm with Touch ID or the Mac password', pt: 'Confirmar com o Touch ID ou a senha do Mac' },
  wiz_setup_remote: {
    en: 'This page is not open on the computer itself (or the computer has no Touch ID, Windows Hello or security key), so the first setup needs the setup code from that computer.',
    pt: 'Esta página não está aberta no próprio computador (ou ele não tem Touch ID, Windows Hello ou chave de segurança), então a primeira configuração precisa do código de configuração daquele computador.',
  },
  rec_recover: { en: 'Recover with the 24 words', pt: 'Recuperar com as 24 palavras' },
  rec_recover_title: { en: 'Recover with your 24 words', pt: 'Recuperar com as suas 24 palavras' },
  rec_recover_intro: {
    en: 'Type or paste your 24 words. They are sent once to this computer, used to open the vault and dropped — never saved and never logged.',
    pt: 'Digite ou cole as suas 24 palavras. Elas vão uma vez para este computador, abrem o cofre e são descartadas — nunca salvas, nunca registradas.',
  },
  rec_recover_after: {
    en: 'The vault is open in recovery mode. Next: choose how it confirms it is you, and make NEW recovery words — the old ones count as exposed.',
    pt: 'O cofre abriu em modo de recuperação. Agora: escolha como ele confirma que é você e crie palavras de recuperação NOVAS — as antigas contam como expostas.',
  },
  rec_recover_go: { en: 'Open the vault', pt: 'Abrir o cofre' },
  rec_recover_count: { en: '{n} of 24 words', pt: '{n} de 24 palavras' },
  rec_recover_local: {
    en: 'Recovery is only accepted from a page opened on this computer (a localhost address).',
    pt: 'A recuperação só é aceita numa página aberta no próprio computador (endereço localhost).',
  },
  rec_continue: { en: 'Continue the setup', pt: 'Continuar a configuração' },
  act_recover: { en: 'Recover with the 24 words', pt: 'Recuperar com as 24 palavras' },
  act_unlock: { en: 'Unlock', pt: 'Destrancar' },
  act_enroll: { en: 'Open the setup', pt: 'Abrir a configuração' },
  act_disable: { en: 'Type the 24 words', pt: 'Digitar as 24 palavras' },
  pres_offWords: { en: 'Your 24 words (main machine)', pt: 'As suas 24 palavras (máquina principal)' },
  // Owner decision 2026-10-06 — which proof each kind of action asks.
  ap_title: { en: 'What each action asks', pt: 'O que cada ação pede' },
  ap_desc: { en: 'Choose whether each kind of action asks {presence} or — for reading only — nothing. Changing this asks you to confirm too.', pt: 'Escolha se cada tipo de ação pede {presence} ou — só para leitura — nada. Mudar isto também pede a sua confirmação.' },
  ap_row_d: { en: '{n} of {total} actions changed from the default', pt: '{n} de {total} ações mudadas do padrão' },
  ap_row_default: { en: 'The default: {presence} for every action', pt: 'O padrão: {presence} em todas as ações' },
  ap_col_action: { en: 'Action', pt: 'Ação' },
  ap_col_proof: { en: 'Asks', pt: 'Pede' },
  ap_critical: { en: 'critical', pt: 'crítica' },
  ap_critical_hint: { en: 'Always at least one confirmation.', pt: 'Sempre pede ao menos uma confirmação.' },
  ap_default_tag: { en: 'default', pt: 'padrão' },
  ap_c_gesture: { en: '{presence}', pt: '{presence}' },
  ap_c_none: { en: 'Nothing', pt: 'Nada' },
  ap_k_open: { en: 'Open the vault', pt: 'Abrir o cofre' },
  ap_k_open_d: { en: 'Always {presence}.', pt: 'Sempre {presence}.' },
  ap_k_reveal: { en: 'Reveal / copy a value', pt: 'Revelar / copiar valor' },
  ap_k_reveal_d: { en: 'Seeing or copying a secret. A secret with "Always confirm" off asks nothing.', pt: 'Ver ou copiar um segredo. Um segredo com "Sempre confirmar" desligado não pede nada.' },
  ap_k_use: { en: 'Use in a session (grant)', pt: 'Usar em sessão (liberar)' },
  ap_k_use_d: { en: 'Handing secrets to an agent session.', pt: 'Entregar segredos a uma sessão de agente.' },
  ap_k_edit: { en: 'Edit', pt: 'Editar' },
  ap_k_edit_d: { en: 'Changing a secret or taking it back from the trash.', pt: 'Mudar um segredo ou tirá-lo da lixeira.' },
  ap_k_delete_secret: { en: 'Delete a secret', pt: 'Excluir segredo' },
  ap_k_delete_secret_d: { en: 'Trash, delete for good, delete a group.', pt: 'Lixeira, excluir de vez, excluir um grupo.' },
  ap_k_delete_device: { en: 'Delete a credential / device', pt: 'Excluir credencial/dispositivo' },
  ap_k_delete_device_d: { en: 'Removing a phone or its passkey.', pt: 'Remover um celular ou a passkey dele.' },
  ap_k_wipe: { en: 'Wipe', pt: 'Apagar' },
  ap_k_wipe_d: { en: 'Erasing the vault, or its older backups.', pt: 'Apagar o cofre, ou os backups antigos dele.' },
  ap_k_settings: { en: 'Security settings', pt: 'Ajustes de segurança' },
  ap_k_settings_d: { en: 'This table, the auto-lock and the phones.', pt: 'Esta tabela, o bloqueio automático e os celulares.' },
  ap_k_recovery: { en: 'Recovery key', pt: 'Chave de recuperação' },
  ap_k_recovery_d: { en: 'Making new 24 words.', pt: 'Gerar 24 palavras novas.' },
  ap_missing: { en: 'Until the vault has a way to confirm, nothing can be asked — choose one above.', pt: 'Enquanto o cofre não tiver uma forma de confirmação, nada pode ser pedido — escolha uma acima.' },
  ap_unreadable: { en: 'The saved choices could not be read, so every action asks you to confirm until you save them again.', pt: 'As escolhas salvas não puderam ser lidas, então toda ação pede a sua confirmação até você salvá-las de novo.' },
  ap_save: { en: 'Save', pt: 'Salvar' },
  ap_reset: { en: 'Back to the defaults', pt: 'Voltar ao padrão' },
} as const satisfies Record<string, Pair>

export type VaultKey = keyof typeof VAULT_TEXT

export function vt(key: VaultKey, lang: Lang): string {
  return VAULT_TEXT[key][lang]
}

/** `vt` with `{name}` placeholders filled — the only interpolation the table uses. */
export function vtf(key: VaultKey, lang: Lang, vars: Record<string, string | number>): string {
  return VAULT_TEXT[key][lang].replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''))
}

/** The user's word for their way to confirm, from the wrapper kinds the vault holds (a gesture first). */
export function presenceKey(wrappers: readonly string[]): VaultKey {
  return wrappers.includes('touchid') ? 'presenceWord_touchid'
    : wrappers.includes('hello') ? 'presenceWord_hello'
      : wrappers.includes('fido2') ? 'presenceWord_fido2'
        : wrappers.includes('password') ? 'presenceWord_password' : 'presenceWord_any'
}
/** A way to confirm, by its name (the wizard's chooser). */
export function methodNameKey(id: string): VaultKey {
  return id === 'touchid' ? 'presenceName_touchid' : id === 'hello' ? 'presenceName_hello' : id === 'password' ? 'presenceName_password' : 'presenceName_fido2'
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

/** PURE. Which lock-screen sentence applies, from the wrappers the service reports for this machine. */
export function lockedSubKey(wrappers: readonly string[] | null | undefined): 'lockedSub_hello' | 'lockedSub_fido2' | 'lockedSub_touchid' | 'lockedSub_password' | 'lockedSub_plain' {
  if (wrappers?.includes('touchid')) return 'lockedSub_touchid'
  if (wrappers?.includes('hello')) return 'lockedSub_hello'
  if (wrappers?.includes('fido2')) return 'lockedSub_fido2'
  if (wrappers?.includes('password')) return 'lockedSub_password'
  return 'lockedSub_plain'
}
