/**
 * Pure logic behind Settings → Providers (`GET/PUT/DELETE /api/provider*`).
 *
 * The wire contract (packages/server) is fixed and reproduced here as types; this module never
 * imports server code. Everything that decides what a row SAYS, what a form REFUSES before it
 * ever reaches the network, and what request body a submit SENDS lives here so
 * `ProvidersSettings.tsx` stays a renderer.
 *
 * The API key itself never appears in this file, in a type, or in a returned string — only the
 * server-issued fingerprint/last4 (`ProviderEntry.fingerprint`/`last4`) are ever displayed.
 */

// The closed set of runtime provider ids (server `config.ts` KEYED_PROVIDERS). Kept here as a
// literal union rather than imported — the web bundle never imports server modules — and the UI
// still never needs to enumerate it by hand: the options offered anywhere in this feature come
// from the GET response, which always lists all seven, in this same order.
export type AiProviderId = 'anthropic' | 'openai' | 'openrouter' | 'deepseek' | 'litellm' | '9router' | 'ollama'

export type ProviderState = 'absent' | 'present' | 'unreadable' | 'permissions-too-open'

export interface ProviderEntry {
  id: AiProviderId
  label: string
  kind: 'direct' | 'router' | 'local'
  defaultBaseUrl: string | null
  baseUrlEditable: boolean
  keyOptional: boolean
  state: ProviderState
  baseUrl?: string
  keyless?: boolean
  fingerprint?: string
  last4?: string
  storedAt?: string
}

export interface Refusal {
  code: string
  /** English, from the server's own sentence helpers. Used as the fallback when no localized
   *  entry exists for `code`. */
  sentence: string
}

export interface ProviderListOk { enabled: true; providers: ProviderEntry[] }
export interface ProviderListRefused { enabled: false; code: string; sentence: string }

export interface ProviderModel {
  id: string
  ownedBy?: string
  contextLength?: number
}

/**
 * UI.5 — what a "test connection" call actually verified. `GET <baseUrl>/models` is a non-billed
 * call that some endpoints answer with NO key at all — a browser configured with a fake OpenRouter
 * key once read "Connected — 458 models" as though the key had been checked, when the endpoint's
 * model list is simply public. 'yes': the endpoint's model-list call is documented to require the
 * key (anthropic/openai/deepseek), so a bad key would have answered `unauthorized` instead. 'no': a
 * public or operator-configured list (openrouter/litellm/9router) — reaching it proves the endpoint
 * answers, not that the key is valid; it is validated on the first real request instead. 'keyless':
 * no key is stored for this provider at all (ollama `--no-key`). Absent on an older server, which
 * read the plain count-and-latency sentence this module always used.
 */
export type KeyCheckedState = 'yes' | 'no' | 'keyless'

export type TestResult =
  | { ok: true; modelCount: number; latencyMs: number; keyChecked?: KeyCheckedState }
  | { ok: false; code: string; status?: number; sentence: string }

// ---------------------------------------------------------------------------------------------
// Row display
// ---------------------------------------------------------------------------------------------

const STATE_TEXT: Record<ProviderState, { en: string; pt: string }> = {
  absent: { en: 'Not configured', pt: 'Não configurado' },
  present: { en: 'Configured', pt: 'Configurado' },
  unreadable: { en: 'Unreadable', pt: 'Ilegível' },
  'permissions-too-open': { en: 'Permissions too open', pt: 'Permissões abertas demais' },
}

export function providerStateLabel(state: ProviderState, pt: boolean): string {
  return pt ? STATE_TEXT[state].pt : STATE_TEXT[state].en
}

/** The dot colour class this row's state maps to, reusing the app's existing status vocabulary
 *  (`StatusDot`'s `ok`/`warn`/`error`/`unknown`) rather than inventing a fifth colour. */
export function providerStateDot(state: ProviderState): 'ok' | 'warn' | 'error' | 'unknown' {
  switch (state) {
    case 'present': return 'ok'
    case 'absent': return 'unknown'
    case 'unreadable': return 'error'
    case 'permissions-too-open': return 'warn'
  }
}

/**
 * "…abcd · fp 1a2b3c" — never anything closer to the actual key. `null` when the server sent
 * neither field (an absent or keyless provider has nothing to mask).
 */
export function providerCredentialMask(entry: Pick<ProviderEntry, 'fingerprint' | 'last4'>): string | null {
  const last4 = entry.last4 ? `…${entry.last4}` : ''
  const fp = entry.fingerprint ? `fp ${entry.fingerprint}` : ''
  if (!last4 && !fp) return null
  return [last4, fp].filter(Boolean).join(' · ')
}

// ---------------------------------------------------------------------------------------------
// Refusal codes → localized sentence, falling back to the server's own English sentence
// ---------------------------------------------------------------------------------------------

// Mirrors packages/server/server/config.ts (the web bundle never imports server code);
// providerSettings.test.ts pins the name against the server's own constant, so a rename there
// breaks the build here instead of leaving these instructions naming a switch that does nothing.
export const PROVIDER_FLAG_ENV = 'AGENTISTICS_PROVIDER'
/** Only `'1'` turns the runtime on (`providerFlagOn` in the server's config.ts). */
export const PROVIDER_FLAG_VALUE = '1'
/** The systemd user unit `agentop autostart server` installs (`unitName('server')` in autostart.ts). */
export const PROVIDER_SERVICE_UNIT = 'agentop-server.service'

const FLAG_ASSIGNMENT = `${PROVIDER_FLAG_ENV}=${PROVIDER_FLAG_VALUE}`

const REFUSAL_TEXT: Record<string, { en: string; pt: string }> = {
  // Same facts as the server's own `refusalSentence('flag-off')`: the runtime is off, and the switch.
  'flag-off': {
    en: `The native provider runtime is off on this machine — set ${FLAG_ASSIGNMENT} to turn it on.`,
    pt: `O runtime nativo de provedores está desligado nesta máquina — defina ${FLAG_ASSIGNMENT} para ligá-lo.`,
  },
  central: {
    en: 'A central has no local runtime, so there is nothing here to configure.',
    pt: 'Uma central não tem runtime local, então não há nada aqui para configurar.',
  },
  key_required: {
    en: 'An API key is required.',
    pt: 'É necessária uma chave de API.',
  },
  // UI.4: a base-URL-only save that moves a stored KEY to another scheme/host/port. The server keeps
  // a key bound to the origin it was entered for, so nobody without the key can redirect it.
  key_required_new_origin: {
    en: 'The stored key stays with the address it was entered for — enter the key again to use a different host.',
    pt: 'A chave salva fica presa ao endereço em que foi cadastrada — digite a chave de novo para usar outro host.',
  },
  not_configured: {
    en: 'This provider has no stored credential yet.',
    pt: 'Este provedor ainda não tem credencial salva.',
  },
  unauthorized: {
    en: 'The provider rejected the stored key.',
    pt: 'O provedor recusou a chave salva.',
  },
  network: {
    en: 'Could not reach the provider.',
    pt: 'Não foi possível alcançar o provedor.',
  },
  'http-error': {
    en: 'The provider answered with an error.',
    pt: 'O provedor respondeu com um erro.',
  },
  'not-json': {
    en: "The provider's answer could not be read.",
    pt: 'A resposta do provedor não pôde ser lida.',
  },
  'bad-shape': {
    en: "The provider's answer was not in the expected shape.",
    pt: 'A resposta do provedor não veio no formato esperado.',
  },
  unknown_provider: {
    en: 'Unknown provider.',
    pt: 'Provedor desconhecido.',
  },
  // /test and /models can also answer with the row's own STATE as the refusal — the stored record
  // exists but cannot be trusted, which is a fact about the file, not about the network call.
  unreadable: {
    en: 'The stored credential could not be read.',
    pt: 'A credencial salva não pôde ser lida.',
  },
  'permissions-too-open': {
    en: 'The stored credential file has permissions that are too open to trust.',
    pt: 'O arquivo da credencial salva tem permissões abertas demais para confiar nele.',
  },
}

/** `key_*` and `base_url_*` cover a family of server-side validation reasons (`key_empty`,
 *  `base_url_invalid`, …) that are not worth naming one by one in two languages — the generic
 *  sentence names the FIELD that was refused, and the server's own `sentence` (shown nowhere in
 *  this function, but available to a caller that wants both) carries the specific reason. */
function genericFieldRefusal(code: string): { en: string; pt: string } | null {
  if (code.startsWith('key_')) {
    return { en: 'The key was refused.', pt: 'A chave foi recusada.' }
  }
  if (code.startsWith('base_url_')) {
    return { en: 'The base URL was refused.', pt: 'A URL base foi recusada.' }
  }
  return null
}

/** Localize a refusal by its `code`, falling back to the server's own `sentence` when this table
 *  has nothing for it — never a raw internal error, always something a person can read. */
export function refusalMessage(refusal: Refusal, pt: boolean): string {
  const exact = REFUSAL_TEXT[refusal.code]
  if (exact) return pt ? exact.pt : exact.en
  const generic = genericFieldRefusal(refusal.code)
  if (generic) return pt ? generic.pt : generic.en
  return refusal.sentence || refusal.code
}

// ---------------------------------------------------------------------------------------------
// The "runtime is off" guide — what Settings → Providers shows instead of a dead end when
// AGENTISTICS_PROVIDER is unset.
//
// ORDER IS THE POINT: the foreground command leads. Measured on WSL (defect t-039fe4c886): with no
// user session / linger `systemctl --user` fails with "Failed to connect to bus", the running
// server is not under the unit at all, and `agentop restart server` printed "Restarted…" while
// changing nothing (same PID, variable absent). So `agentop restart server` is deliberately NOT a
// step anywhere below — the systemd option restarts through systemctl itself — and the systemd
// option is offered only where `systemctl --user status` answers.
// ---------------------------------------------------------------------------------------------

export interface ProviderOffStep {
  /** One sentence saying what the block below it is for. */
  text: string
  /** Shown in a copyable block; a multi-line value is copied whole. */
  command: string
}

export interface ProviderOffSection {
  heading: string
  /** One sentence of condition/caveat, shown under the heading before the steps. */
  note?: string
  steps: ProviderOffStep[]
}

export interface ProviderOffGuide {
  title: string
  lead: string
  sections: ProviderOffSection[]
  after: string
}

/** The one caveat sentence of the systemd option (exact wording, pinned by a test). */
export const SYSTEMD_BUS_CAVEAT = {
  en: 'if systemctl says Failed to connect to bus, use the foreground command.',
  pt: 'se o systemctl disser Failed to connect to bus, use o comando em primeiro plano.',
}

/** Only ever shown for a solo/member machine: a central is refused (403 `central`) before the
 *  flag is looked at, and the Providers section is hidden there. */
export function providerOffGuide(pt: boolean): ProviderOffGuide {
  const dropIn = `[Service]\nEnvironment=${FLAG_ASSIGNMENT}`
  const status = `systemctl --user status ${PROVIDER_SERVICE_UNIT}`
  return pt
    ? {
        title: 'O runtime nativo está desligado nesta máquina',
        lead: `Ele só liga quando o servidor inicia com ${FLAG_ASSIGNMENT}.`,
        sections: [
          {
            heading: 'Em primeiro plano (funciona em qualquer máquina)',
            steps: [
              { text: 'Pare o servidor que está rodando e inicie-o com a variável na frente:', command: `${FLAG_ASSIGNMENT} agentop server` },
              { text: 'No repositório, ao rodar o modo de desenvolvimento:', command: `${FLAG_ASSIGNMENT} bun run dev` },
            ],
          },
          {
            heading: 'Como serviço (systemd do usuário)',
            note: `Só para máquinas em que ${status} responde — ${SYSTEMD_BUS_CAVEAT.pt}`,
            steps: [
              { text: '1. Abra o override do serviço:', command: `systemctl --user edit ${PROVIDER_SERVICE_UNIT}` },
              { text: '2. No editor, escreva estas duas linhas e salve:', command: dropIn },
              { text: '3. Reinicie o serviço:', command: `systemctl --user restart ${PROVIDER_SERVICE_UNIT}` },
            ],
          },
        ],
        after: 'Depois de reiniciar, recarregue esta página.',
      }
    : {
        title: 'The native runtime is off on this machine',
        lead: `It only turns on when the server starts with ${FLAG_ASSIGNMENT}.`,
        sections: [
          {
            heading: 'In the foreground (works on any machine)',
            steps: [
              { text: 'Stop the running server first, then start it with the variable in front:', command: `${FLAG_ASSIGNMENT} agentop server` },
              { text: 'In the repository, when running the dev mode:', command: `${FLAG_ASSIGNMENT} bun run dev` },
            ],
          },
          {
            heading: 'As a service (systemd user unit)',
            note: `Only for machines where ${status} answers — ${SYSTEMD_BUS_CAVEAT.en}`,
            steps: [
              { text: '1. Open the service override:', command: `systemctl --user edit ${PROVIDER_SERVICE_UNIT}` },
              { text: '2. In the editor, write these two lines and save:', command: dropIn },
              { text: '3. Restart the service:', command: `systemctl --user restart ${PROVIDER_SERVICE_UNIT}` },
            ],
          },
        ],
        after: 'After it restarts, reload this page.',
      }
}

export function testResultSentence(result: TestResult, pt: boolean): string {
  if (result.ok) {
    const count = pt
      ? `${result.modelCount} ${result.modelCount === 1 ? 'modelo' : 'modelos'}`
      : `${result.modelCount} ${result.modelCount === 1 ? 'model' : 'models'}`
    if (result.keyChecked === 'yes') {
      return pt
        ? `Conectado — chave aceita — ${count}, ${result.latencyMs}ms`
        : `Connected — key accepted — ${count}, ${result.latencyMs}ms`
    }
    const base = pt ? `Conectado — ${count}, ${result.latencyMs}ms` : `Connected — ${count}, ${result.latencyMs}ms`
    if (result.keyChecked === 'no') {
      return pt
        ? `${base}. Isso não confirma a chave — ela só será validada na primeira solicitação real.`
        : `${base}. This does not confirm the key — it will be validated on the first real request.`
    }
    if (result.keyChecked === 'keyless') {
      return pt
        ? `${base}. Nenhuma chave está salva para este provedor.`
        : `${base}. No key is stored for this provider.`
    }
    return base
  }
  return refusalMessage(result, pt)
}

// ---------------------------------------------------------------------------------------------
// Test-state bookkeeping — a "Connected — N models" reading describes a credential that may no
// longer be the one stored. `ProvidersSettings.tsx` holds one `TestStateMap` for the whole page;
// this is the pure rule for what a successful remove or save must do to it.
// ---------------------------------------------------------------------------------------------

export type TestStateMap = Partial<Record<AiProviderId, { loading: boolean; result?: TestResult }>>

/** Drop `id`'s test/model-count reading. Used after a successful DELETE (so "Connected — 458
 *  models" does not linger next to "Not configured") and after a successful PUT (a changed base
 *  URL or key invalidates whatever the previous test proved — a stale "Connected" beside a just-
 *  edited credential is a claim about a credential that no longer exists). */
export function clearTestState(state: TestStateMap, id: AiProviderId): TestStateMap {
  if (!(id in state)) return state
  const next = { ...state }
  delete next[id]
  return next
}

// ---------------------------------------------------------------------------------------------
// Form validation and body-building — the PUT never gets a call the server would refuse for a
// reason the form already knew, and the key never rides through anything but a local variable.
// ---------------------------------------------------------------------------------------------

export interface ProviderFormInput {
  baseUrl: string
  /** Whether the key field currently holds anything — never the key itself. */
  hasKeyTyped: boolean
  noKey: boolean
}

export type ProviderFormRules = Pick<ProviderEntry, 'baseUrlEditable' | 'defaultBaseUrl' | 'keyOptional' | 'state'>

export type ProviderFormValidation =
  | { ok: true }
  | { ok: false; code: 'base_url_required' | 'key_required' }

export function validateProviderForm(input: ProviderFormInput, rules: ProviderFormRules): ProviderFormValidation {
  if (rules.baseUrlEditable && rules.defaultBaseUrl === null && !input.baseUrl.trim()) {
    return { ok: false, code: 'base_url_required' }
  }
  const keyAlreadyStored = rules.state === 'present'
  const skippingOnPurpose = input.noKey && rules.keyOptional
  if (!input.hasKeyTyped && !keyAlreadyStored && !skippingOnPurpose) {
    return { ok: false, code: 'key_required' }
  }
  return { ok: true }
}

export interface ProviderPutBody { baseUrl?: string; key?: string; noKey?: boolean }

export interface ProviderPutInput {
  baseUrl: string
  baseUrlEditable: boolean
  /** The typed key, read once from the input ref — never a piece of React state. Empty string
   *  means "leave the stored key alone" (or "no key" when `noKey` is set). */
  keyTyped: string
  noKey: boolean
  keyOptional: boolean
}

/** Only ever includes `baseUrl` when the provider accepts one, only ever includes `key` when
 *  something was actually typed (an empty key field means "keep the stored key" per the
 *  contract), and `noKey` only when it applies and no key was typed instead. */
export function buildProviderPutBody(input: ProviderPutInput): ProviderPutBody {
  const body: ProviderPutBody = {}
  if (input.baseUrlEditable) {
    const trimmed = input.baseUrl.trim()
    if (trimmed) body.baseUrl = trimmed
  }
  if (input.keyTyped) {
    body.key = input.keyTyped
  } else if (input.noKey && input.keyOptional) {
    body.noKey = true
  }
  return body
}

// ---------------------------------------------------------------------------------------------
// Models list
// ---------------------------------------------------------------------------------------------

export function filterModels(models: ProviderModel[], query: string): ProviderModel[] {
  const q = query.trim().toLowerCase()
  if (!q) return models
  return models.filter(m => m.id.toLowerCase().includes(q) || (m.ownedBy ?? '').toLowerCase().includes(q))
}

/** "live, updated 3 min ago" / "from cache, updated just now" — `now` is injectable for tests. */
export function modelsFetchedSentence(fetchedAt: string, fromCache: boolean, pt: boolean, now: number = Date.now()): string {
  const ms = Date.parse(fetchedAt)
  const mins = Number.isFinite(ms) ? Math.max(0, Math.round((now - ms) / 60_000)) : null
  const when = mins === null
    ? (pt ? 'agora' : 'just now')
    : mins < 1
      ? (pt ? 'agora' : 'just now')
      : mins < 60
        ? (pt ? `há ${mins} min` : `${mins} min ago`)
        : (pt ? `há ${Math.round(mins / 60)}h` : `${Math.round(mins / 60)}h ago`)
  const source = fromCache ? (pt ? 'em cache' : 'from cache') : (pt ? 'ao vivo' : 'live')
  return pt ? `${source}, atualizado ${when}` : `${source}, updated ${when}`
}
