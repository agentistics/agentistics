import type { HarnessId } from '@agentistics/core'
import type { ChatMessage, StreamViaClaudioOpts } from '../chat-tty'

export interface ChatStreamCallbacks {
  onChunk: (t: string) => void
  onTool: (n: string) => void
  onDone: () => void
  onError: (e: string) => void
  onSessionId?: (id: string) => void
}

export interface ChatDriverModel {
  id: string
  label: string
  badge?: string
  desc?: string
  inputPer1M?: number
  outputPer1M?: number
}

/** Static setup guidance shown to users when a harness is not installed or not authed. */
export interface ChatDriverSetup {
  /** Shell command to install the CLI (e.g. 'npm i -g @openai/codex'). */
  installCmd?: string
  /** Shell command to authenticate (e.g. 'codex login'). */
  loginCmd?: string
  /** URL to official docs or the product page. */
  docUrl?: string
  /** Extra human-readable note (e.g. eligibility caveat). */
  note?: string
}

export interface ChatDriver {
  id: HarnessId
  label: string
  isAvailable(): boolean
  /** Best-effort check: does the auth/config file exist for this harness? */
  authReady(): boolean
  /** Static guidance for install / login. */
  setup: ChatDriverSetup
  ensureMcp(port: number): Promise<void>
  stream(
    message: string,
    history: ChatMessage[],
    model: string,
    cb: ChatStreamCallbacks,
    resumeSessionId?: string | null,
    opts?: StreamViaClaudioOpts,
  ): Promise<void>
}

/** Per-harness status payload returned by GET /api/chat-harnesses. */
export interface HarnessChatStatus {
  id: HarnessId
  label: string
  /** CLI binary is found on PATH. */
  installed: boolean
  /** Auth/config file is present (best-effort). */
  authReady: boolean
  /** installed && authReady — driver is usable. */
  ready: boolean
  /** CLI version when it can be read. */
  version?: string
  /** Reserved for a future official-latest check. */
  updateAvailable?: boolean
  /** From `model-catalog.ts` — the CLI's own list where it publishes one, else the verified table. */
  models: ChatDriverModel[]
  /** `cli`: the harness's own list. `table`: the incomplete fallback — see `modelFreeText`. */
  modelsSource: 'cli' | 'table'
  /** The picker must also accept a typed id (the list is the table, which cannot name them all). */
  modelFreeText: boolean
  /**
   * What this machine's CLI uses when no model is passed, read from its own settings file, or `''`
   * — never an invented one. `''` sends no `--model` at all.
   */
  defaultModel: string
  setup: ChatDriverSetup
}
