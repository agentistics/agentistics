/** PURE: the words and the ordering of the OpenCode provider connection dialog (Settings → Billing). */

export interface OcProvider { id: string; label: string; url: string; kind: 'go' | 'zen' | 'byo' }
export interface OcConnected { id: string; label: string; type: string }

export const OC_COPY = (pt: boolean) => ({
  section: pt ? 'Provedores do OpenCode' : 'OpenCode providers',
  add: pt ? 'Conectar provedor' : 'Connect provider',
  none: pt ? 'Nenhum provedor conectado. OpenCode Go e Zen aparecem aqui depois de colar a chave.' : 'No provider connected. OpenCode Go and Zen show up here once you paste the key.',
  title: pt ? 'Conectar provedor do OpenCode' : 'Connect an OpenCode provider',
  provider: pt ? 'Provedor' : 'Provider',
  stepOpen: pt ? 'Crie a chave no console' : 'Create the key in the console',
  stepOpenNote: (p: OcProvider) => p.kind === 'go' || p.kind === 'zen'
    ? (pt ? 'Console → Personal → API Keys. Uma chave restrita (modelos: request; orçamento usado: read) basta.' : 'Console → Personal → API Keys. A restricted key (models: request, used budgets: read) is enough.')
    : (pt ? 'A chave é a do próprio provedor.' : 'The key is the provider’s own.'),
  openLink: pt ? 'Abrir o console' : 'Open the console',
  stepPaste: pt ? 'Cole a chave' : 'Paste the key',
  stepPasteNote: pt ? 'Ela é gravada no auth.json do OpenCode (somente você lê) e não aparece em nenhum registro.' : 'It is written to OpenCode’s auth.json (readable only by you) and appears in no log.',
  save: pt ? 'Conectar' : 'Connect',
  cancel: pt ? 'Cancelar' : 'Cancel',
  close: pt ? 'Fechar' : 'Close',
  remove: (name: string) => pt ? `Remover ${name}` : `Remove ${name}`,
  removeTitle: (name: string) => pt ? `Remover ${name}?` : `Remove ${name}?`,
  removeNote: pt ? 'A chave sai do auth.json. A conta no console continua existindo.' : 'The key leaves auth.json. The console account still exists.',
  removeConfirm: pt ? 'Remover' : 'Remove',
  movedGo: pt ? 'Era uma chave do OpenCode Go: foi guardada como OpenCode Go.' : 'That was an OpenCode Go key: it was saved as OpenCode Go.',
  saved: pt ? 'Conectado.' : 'Connected.',
  failed: pt ? 'Não foi possível gravar a chave.' : 'Could not save the key.',
  fix: pt ? 'Corrigir chave do Go' : 'Fix Go key',
  fixNote: pt ? 'Há uma chave em “OpenCode Zen”. Se for do Go, ela some dos modelos do Go.' : 'There is a key under “OpenCode Zen”. If it is a Go key, the Go models stay hidden.',
  fixed: pt ? 'Chave movida para OpenCode Go.' : 'Key moved to OpenCode Go.',
  notGo: pt ? 'Essa chave não é do Go; nada mudou.' : 'That key is not a Go key; nothing changed.',
  type: (t: string) => t === 'oauth' ? 'OAuth' : (pt ? 'chave' : 'key'),
})

/** The picker order: OpenCode's own products first, then the rest by name; already-connected ones last. */
export function pickerOrder(providers: readonly OcProvider[], connected: readonly OcConnected[]): OcProvider[] {
  const have = new Set(connected.map(c => c.id))
  const rank = (p: OcProvider) => (have.has(p.id) ? 2 : p.kind === 'byo' ? 1 : 0)
  return [...providers].sort((a, b) => rank(a) - rank(b))
}

/** A `opencode` (Zen) entry exists and `opencode-go` does not: the shape a misfiled Go key leaves. */
export function maybeMisfiledGo(connected: readonly OcConnected[]): boolean {
  const ids = new Set(connected.map(c => c.id))
  return ids.has('opencode') && !ids.has('opencode-go')
}
