/**
 * LIVRO.SEAMS: the one place that asks the engine's hand-off book to reconcile its durable passages
 * (reattach a live one, roll back an expired one). Called by the long-lived `agentop server` only — a
 * one-shot CLI process (`--version`, `mcp`, `book …`, `flow …`) loads the engine without ever calling it,
 * so it never creates `livro.db`/`livro.keys`, never rolls back and never stops a successor.
 * Contained: a failing boot is logged and never throws out of here.
 */
export async function startEngineBook(
  engine: { book?: { start?: () => Promise<void> } } | null | undefined,
  log: (line: string) => void = line => console.warn(line),
): Promise<void> {
  try {
    await engine?.book?.start?.()
  } catch (err) {
    log(`[book] boot failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
