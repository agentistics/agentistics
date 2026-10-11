/**
 * fork-capability.ts — the measured continuation/account-switch boundary.
 *
 * A harness must earn fork-following: a new transcript file is otherwise indistinguishable from
 * another conversation in the same workspace. Claude is the only harness for which the transcript
 * successor probe has been measured. The other structured harnesses are deliberately declared
 * unsupported until their own stores provide an equivalent exclusive proof.
 */
import type { HarnessId } from '@agentistics/core'

export interface ForkCapability {
  follow: boolean
  /** Short, user-facing reason when follow is not available. */
  absent?: string
  /** The probe/source that earned the capability. */
  probe: string
}

export const FORK_CAPABILITIES: Record<HarnessId, ForkCapability> = {
  claude: { follow: true, probe: 'transcript successor UUID overlap + pending prompt' },
  codex: { follow: false, absent: 'Codex account-switch/fork continuation is not verified on this machine.', probe: 'not verified' },
  gemini: { follow: false, absent: 'Gemini account-switch/fork continuation is not verified on this machine.', probe: 'not verified' },
  kimi: { follow: false, absent: 'Kimi account-switch/fork continuation is not verified on this machine.', probe: 'not verified' },
  copilot: { follow: false, absent: 'Copilot account-switch/fork continuation is not verified on this machine.', probe: 'not verified' },
  antigravity: { follow: false, absent: 'Antigravity account-switch/fork continuation is not verified on this machine.', probe: 'not verified' },
  opencode: { follow: false, absent: 'OpenCode transcript fork continuation is not verified on this machine.', probe: 'not verified' },
}

export function forkCapabilityFor(harness: string | undefined): ForkCapability {
  return FORK_CAPABILITIES[(harness ?? '') as HarnessId] ?? {
    follow: false, absent: 'This harness’s account-switch/fork continuation is not verified.', probe: 'not verified',
  }
}

export function forkCapabilitySentence(harness: string | undefined, lang: 'pt' | 'en'): string | undefined {
  const c = forkCapabilityFor(harness)
  if (c.follow) return undefined
  return lang === 'pt'
    ? 'A troca de conta/ramificação desta ferramenta não foi verificada; a conversa não será seguida automaticamente.'
    : 'This tool’s account-switch/fork continuation is not verified; the conversation will not be followed automatically.'
}
