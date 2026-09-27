/**
 * tool-call-stream.ts — PURE. Turns a stream of Anthropic-shaped tool_use content-block events
 * (`content_block_start` / `content_block_delta` / `content_block_stop`) into complete, validated
 * `AssembledToolCall`s, or a named `ToolCallFailure` when the accumulated text cannot become one.
 * Never executed here (B3 is the executor) — this module only ASSEMBLES a call, it never runs one.
 *
 * spec: docs/superpowers/specs/2026-09-19-agentistics-runtime-master.md §22 ("Tool arguments also
 * arrive differently: Anthropic streams partial JSON text that resolves to an object, OpenAI keeps
 * `arguments` a JSON string, and Google hands over an already-parsed object" — this module is the
 * Anthropic half of that sentence). Sibling item B2.1 wires `createToolCallAssembler` into the live
 * Anthropic stream against the exact public interface below; nothing here may rename it.
 *
 * Anthropic's own streaming reference (docs.anthropic.com/en/api/messages-streaming, "Input JSON
 * delta") documents the shape this reads: a `content_block_start` of `content_block.type ===
 * "tool_use"` carrying `id`/`name` and an EMPTY `input: {}`, zero or more `content_block_delta`
 * events of `delta.type === "input_json_delta"` carrying a `partial_json` STRING fragment
 * (concatenate them in order — never attempt to parse mid-stream, a prefix of JSON is essentially
 * never itself valid JSON), and a closing `content_block_stop`. The docs state explicitly that a
 * tool with no arguments may stream ZERO `input_json_delta` fragments at all, or a single
 * empty-string one — so an empty accumulated text is not malformed, it parses as `{}`
 * (`finalizeInput` below).
 *
 * A provider's stream is UNTRUSTED INPUT. Every method here is total and never throws: on an index
 * nothing `start`ed, on a `stop` for an index already stopped, on a `start` repeated on an index
 * still open, and on argument values that do not match the types this module declares (a caller's
 * own bug can still hand these methods garbage past the type system — `tool-call-stream.test.ts`
 * exercises exactly that).
 */
import type { ProviderToolDecl, ToolCallFailure } from './client.ts'

/** One streamed tool call, fully assembled and parsed. Never executed here — B3's job. */
export interface AssembledToolCall {
  index: number
  id: string
  name: string
  input: Record<string, unknown>
}

export type ToolCallStep = { ok: true; call: AssembledToolCall } | { ok: false; failure: ToolCallFailure }

export interface ToolCallAssembler {
  /** `content_block_start`, `content_block.type === 'tool_use'`. */
  start(index: number, id: string, name: string): void
  /** `content_block_delta`, `delta.type === 'input_json_delta'`; `partialJson` is `delta.partial_json`. */
  append(index: number, partialJson: string): void
  /**
   * `content_block_stop`. `opts.truncated` states that the response ended (typically `max_tokens`)
   * before this block closed normally — see the reasoning inlined below for why that always fails
   * the call, even when the accumulated text happens to parse.
   */
  stop(index: number, opts?: { truncated?: boolean }): ToolCallStep
  /** Any block `start`ed and never `stop`ped — the stream ended mid-call. Call once, at stream end. */
  finish(): ToolCallFailure[]
}

/**
 * A safety ceiling on one call's accumulated argument TEXT, measured in UTF-16 code units
 * (`String.length` of the concatenated fragments) rather than exact UTF-8 bytes. Re-encoding the
 * running text to count real bytes on every `append` would cost as much as the parse this cap exists
 * to avoid paying for on a runaway stream, and tool arguments are overwhelmingly ASCII JSON (paths,
 * short strings, numbers) — undercounting the rare non-ASCII character only means the true byte
 * ceiling for pathological input is a little HIGHER than the name states, never lower, which is the
 * safe direction for a defensive bound. 1 MiB is generous for any call this product's tools declare
 * (arguments carry paths and short content, not whole file bodies) while still bounding a stream
 * that never sends `content_block_stop` for a block it keeps feeding forever.
 */
export const MAX_TOOL_ARGS_BYTES = 1024 * 1024

const USER_CODE: Record<ToolCallFailure['reason'], string> = {
  malformed: 'provider.tool_call_malformed',
  truncated: 'provider.tool_call_truncated',
  'not-object': 'provider.tool_call_not_object',
  'unknown-tool': 'provider.tool_call_unknown_tool',
}

function failure(index: number, id: string, name: string, reason: ToolCallFailure['reason']): ToolCallFailure {
  return { index, id, name, reason, userCode: USER_CODE[reason] }
}

interface OpenCall {
  id: string
  name: string
  parts: string[]
  length: number
  /** true once `append` would have crossed `MAX_TOOL_ARGS_BYTES` — every later append is dropped too. */
  overCap: boolean
}

/**
 * `tools` names the DECLARED set a call's `name` is checked against (`unknown-tool`). Absent, or an
 * empty/non-array value, means the caller did not declare a closed set — the check is skipped
 * entirely rather than treating "nothing declared" as "everything is unknown" (spec: "When tools is
 * undefined, skip that check" — the same reading extends to an empty list, which states just as
 * little about what names are valid).
 */
export function createToolCallAssembler(tools?: ProviderToolDecl[]): ToolCallAssembler {
  const declared: Set<string> | undefined =
    Array.isArray(tools) && tools.length > 0
      ? new Set(tools.filter((t) => t !== null && typeof t === 'object' && typeof t.name === 'string').map((t) => t.name))
      : undefined

  const open = new Map<number, OpenCall>()

  function start(index: number, id: string, name: string): void {
    if (typeof index !== 'number' || !Number.isFinite(index)) return
    // A second `start` on an index already open REPLACES it outright, discarding whatever text had
    // accumulated for the previous one. A well-formed stream never opens one index twice; when
    // untrusted input does anyway, the most recent declaration is treated as authoritative rather
    // than merging two calls' worth of fragments — merging would silently combine arguments that
    // belong to two distinct tool_use blocks the stream itself never joined into one call.
    open.set(index, {
      id: typeof id === 'string' ? id : '',
      name: typeof name === 'string' ? name : '',
      parts: [],
      length: 0,
      overCap: false,
    })
  }

  function append(index: number, partialJson: string): void {
    const entry = open.get(index)
    // An append against an index nothing `start`ed is dropped: there is no call to attach the
    // fragment to, and inventing one from an append alone would fabricate an id/name this module was
    // never given for it.
    if (entry === undefined) return
    if (typeof partialJson !== 'string' || partialJson.length === 0) return
    if (entry.overCap) return // already discarding for this call — see MAX_TOOL_ARGS_BYTES above
    if (entry.length + partialJson.length > MAX_TOOL_ARGS_BYTES) {
      // Once the cap would be crossed, no further bytes for this call are kept AT ALL — not even the
      // portion of this fragment that would still fit. The accumulated text is already unusable for
      // reconstructing the real object once any of it has been silently dropped, so keeping a
      // partial prefix buys nothing; freeing it is what actually bounds memory for the stream that
      // triggered the cap.
      entry.overCap = true
      entry.parts.length = 0
      entry.length = 0
      return
    }
    entry.parts.push(partialJson)
    entry.length += partialJson.length
  }

  function stop(index: number, opts?: { truncated?: boolean }): ToolCallStep {
    const entry = open.get(index)
    if (entry === undefined) {
      // Unknown index — either never opened, or already stopped once. A block's entry is removed
      // from the open set the moment `stop` returns (below), so a second `stop` on the same index is
      // indistinguishable from a `stop` on an index that was never opened, and answers the same way:
      // a well-formed stream never stops one block twice, so both are untrusted-input handling
      // rather than an ordinary lifecycle path, and there is no id/name to report for either.
      return { ok: false, failure: failure(typeof index === 'number' && Number.isFinite(index) ? index : -1, '', '', 'malformed') }
    }
    open.delete(index)

    if (entry.overCap) {
      // Bytes were already discarded while accumulating; there is no text left that could
      // reconstruct the real arguments, truncated flag or not — this check runs before the
      // truncation check below on purpose, since "some of the input is gone" is true regardless of
      // why the block eventually stopped.
      return { ok: false, failure: failure(index, entry.id, entry.name, 'malformed') }
    }

    if (opts?.truncated === true) {
      // The response ended (typically hitting `max_tokens`) before this block closed normally. The
      // accumulated text is refused EVEN WHEN IT HAPPENS TO PARSE AS VALID JSON: the provider's own
      // truncation signal states generation was cut off mid-response, and a value that parses
      // successfully up to the cut point does not prove the model had finished producing it — the
      // next byte it would have written after the cut is exactly the information a cut stream
      // withholds, and nothing about the accumulated text can distinguish "this object was already
      // complete" from "the cut landed right after a syntactically-closing brace that belonged to a
      // larger, still-unfinished value". Treating a coincidentally-balanced prefix as complete would
      // make correctness depend on where in the response the token limit happened to land, which is
      // a fact about the RESPONSE's length budget, never a fact about this tool call's arguments.
      return { ok: false, failure: failure(index, entry.id, entry.name, 'truncated') }
    }

    const parsed = finalizeInput(entry.parts.join(''))
    if (parsed.ok === false) return { ok: false, failure: failure(index, entry.id, entry.name, parsed.reason) }

    // Checked AFTER parsing on purpose: a stream that cannot even produce valid JSON has a more
    // fundamental problem than an unrecognized tool name, and every declared tool is equally
    // affected by a broken stream — surfacing `malformed`/`not-object` first avoids masking a parse
    // defect behind an "unknown tool" report that would be just as true of a perfectly normal call.
    if (declared !== undefined && !declared.has(entry.name)) {
      return { ok: false, failure: failure(index, entry.id, entry.name, 'unknown-tool') }
    }

    return { ok: true, call: { index, id: entry.id, name: entry.name, input: parsed.value } }
  }

  function finish(): ToolCallFailure[] {
    const out: ToolCallFailure[] = []
    const indices = Array.from(open.keys()).sort((a, b) => a - b)
    for (const index of indices) {
      const entry = open.get(index)
      if (entry === undefined) continue
      out.push(failure(index, entry.id, entry.name, 'truncated'))
    }
    open.clear()
    return out
  }

  return { start, append, stop, finish }
}

type FinalizedInput =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'malformed' | 'not-object' }

/**
 * Parses one call's fully-accumulated argument text. An empty (or whitespace-only) text parses as
 * `{}` per Anthropic's own documented "a tool with no arguments may stream zero fragments, or a
 * single empty-string one" — `JSON.parse('')` throws, so this is checked BEFORE parsing rather than
 * caught after, and a whitespace-only text is folded into the same case since JSON never carries
 * meaning in bare whitespace.
 *
 * **`required`-key validation against the tool's `inputSchema` is deliberately NOT done here.** It
 * was asked for explicitly and rejected: `ToolCallFailure.reason` is a closed set of four values
 * (`malformed` / `truncated` / `not-object` / `unknown-tool`) and none of them means "a well-formed
 * object is missing a field its schema requires" — forcing that case into `not-object` (a value that
 * is not an object at all) or `malformed` (text that is not JSON at all) would misreport WHY the
 * call failed to a caller that reads the reason to decide what to say or do next. A syntactically
 * valid object is therefore always `ok: true` here, `required` fields present or not; B3 (the
 * executor) validates the full `inputSchema` — `required` included — immediately before running a
 * call, which is also where a new, honestly-named failure mode for "missing a required field" belongs
 * if this product ever wants one on the assembly side too.
 */
function finalizeInput(text: string): FinalizedInput {
  if (text.trim().length === 0) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}
