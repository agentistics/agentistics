/**
 * transcript-availability.ts — moved to `@agentistics/core` (LIVE.1): the state lives in
 * `canonical/transcript.ts`, its sentence in `transcriptSentence.ts`. Re-exported so the old path
 * keeps resolving.
 */
export {
  TRANSCRIPT_RETENTION,
  transcriptAvailability,
  type TranscriptAvailability,
  type TranscriptReason,
  type TranscriptState,
} from '@agentistics/core'
export { transcriptSentence } from '@agentistics/core'
