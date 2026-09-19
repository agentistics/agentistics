/**
 * viewed-image.ts — PURE: the companion entry Claude Code writes when the ASSISTANT opens an image
 * with the `Read` tool, and which `Read` call it is describing.
 *
 * Measured on a real transcript: `[Image: original 2223x888, displayed at 2000x799. Multiply
 * coordinates by 1.11 to map to original image.]` — a `type: 'user'`, `isMeta: true,
 * turnCompanion: true` entry, one per Read whose image needed downscaling for display (a 910x854
 * and an 897x149 read in the SAME turn produced no companion at all; only the 2223x888 one, over
 * the display width, did). It is NOT an attachment — see `attachment-companion.ts`'s
 * `[Image: source: <path>]` shape for that, a different note the harness writes under the same
 * flags. This one previously fell into the SAME `^\[Image:/` bucket in `chat-envelope.ts` and was
 * shown as "an image was attached", which says the wrong thing (nobody attached anything) and links
 * to a Gallery that was never built to hold it.
 *
 * WHICH `Read` CALL IT DESCRIBES is answered by walking the companion's OWN `parentUuid` chain, not
 * by counting or by position. Measured on the same transcript: a turn can hold SEVERAL `Read` calls
 * on images (three, in the sample) while only ONE gets a companion — pairing by order or by count
 * would have paired the note with the FIRST read instead of the (correct) third. The chain is
 * `companion.parentUuid` -> the `tool_result` entry naming it (its own `uuid`) -> that result's
 * `tool_use_id` -> the assistant's `tool_use` block carrying that id. Every step is an EXACT id
 * match; a step that cannot be resolved, or resolves to something ambiguous (a `tool_result`
 * carrying more than one image block, a tool_use that is not `Read`), refuses rather than guesses —
 * the same rule `resolveMarkerPaths` and `subagent-join.ts` already apply to their own links.
 */

/** A note this file is describing is prefix-shaped like this — see the module header. */
export const VIEWED_IMAGE_RE = /^\[Image: original \d+x\d+, displayed at \d+x\d+/

/**
 * How far back the chain may be walked from the companion — bounded, because the chain is always
 * this short in practice (an assistant `tool_use`, its own `tool_result`, then the companion) and an
 * unrelated transcript shape must refuse rather than search arbitrarily far for a coincidence.
 */
const CHAIN_BOUND = 20

function parseLine(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  try { return JSON.parse(trimmed) as Record<string, unknown> } catch { return null }
}

/** Walk backward from `fromIndex`, bounded, for the entry whose OWN `uuid` is `uuid`. */
function findEntryByUuid(
  lines: readonly string[], fromIndex: number, uuid: string,
): { entry: Record<string, unknown>; index: number } | null {
  const floor = Math.max(0, fromIndex - CHAIN_BOUND)
  for (let i = fromIndex; i >= floor; i--) {
    const e = parseLine(lines[i])
    if (e && e.uuid === uuid) return { entry: e, index: i }
  }
  return null
}

/**
 * The `tool_use_id` of a `tool_result` entry naming EXACTLY one image — or `null` when the entry is
 * not that shape, or names more than one (ambiguous: which image is this companion about?).
 */
function soleImageResultId(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'user') return null
  const content = (entry.message as Record<string, unknown> | undefined)?.content
  if (!Array.isArray(content) || content.length !== 1) return null
  const block = content[0] as Record<string, unknown>
  if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return null
  const inner = block.content
  if (!Array.isArray(inner) || inner.length !== 1) return null
  const img = inner[0] as Record<string, unknown> | undefined
  return img?.type === 'image' ? block.tool_use_id : null
}

/** Walk backward from `fromIndex`, bounded, for the assistant `tool_use` block carrying `toolUseId`. */
function findToolUseById(
  lines: readonly string[], fromIndex: number, toolUseId: string,
): { name: string; input: Record<string, unknown> } | null {
  const floor = Math.max(0, fromIndex - CHAIN_BOUND)
  for (let i = fromIndex; i >= floor; i--) {
    const e = parseLine(lines[i])
    if (!e || e.type !== 'assistant') continue
    const content = (e.message as Record<string, unknown> | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const part of content as Record<string, unknown>[]) {
      if (part.type === 'tool_use' && part.id === toolUseId) {
        return { name: typeof part.name === 'string' ? part.name : '', input: (part.input ?? {}) as Record<string, unknown> }
      }
    }
  }
  return null
}

/**
 * The `Read` call's OWN `file_path`, resolved through the EXACT chain above — or `null` when any
 * link is missing, out of the bound, or ambiguous.
 *
 * `lines` is the raw transcript, in file order; `companionIndex` is where the companion entry sits.
 * Both readers in `chat-tail.ts` already hold this array while walking it, so this costs nothing
 * beyond the few lines the chain actually spans — never a second pass over the whole file.
 */
export function resolveViewedImagePath(
  lines: readonly string[], companionIndex: number,
): string | null {
  const companion = parseLine(lines[companionIndex])
  const parentUuid = typeof companion?.parentUuid === 'string' ? companion.parentUuid : null
  if (!parentUuid) return null

  const resultHit = findEntryByUuid(lines, companionIndex - 1, parentUuid)
  if (!resultHit) return null
  const toolUseId = soleImageResultId(resultHit.entry)
  if (!toolUseId) return null

  const use = findToolUseById(lines, resultHit.index - 1, toolUseId)
  if (!use || use.name !== 'Read') return null
  const filePath = use.input.file_path
  return typeof filePath === 'string' && filePath !== '' ? filePath : null
}
