/**
 * native-id-alias.ts — PURE. Look a session up by the id the HARNESS calls it, as well as by the
 * store's key.
 *
 * Gemini's store key is the synthetic `<project>/<file>`, while agentop assigns (and records on the
 * registry row, and files on a task) the UUID the CLI takes — `SessionMeta.native_session_id`. A
 * `Map<session_id, SessionMeta>` read by `row.conversationId` therefore found nothing for such a row,
 * and a delivery holding it priced as an unlinked conversation.
 *
 * The alias lives on LOOKUP only. It is a `Map` subclass whose `get`/`has` fall back to the alias
 * and whose iteration is untouched, so a caller that walks the map (`task-stats`, `task-filter`)
 * still sees each session exactly ONCE — adding the alias as a second key would count it twice.
 */

import type { SessionMeta } from '@agentistics/core'

class AliasedMetas extends Map<string, SessionMeta> {
  private readonly aliases = new Map<string, string>()

  constructor(source: ReadonlyMap<string, SessionMeta>) {
    super(source)
    for (const [key, meta] of source) {
      const native = meta.native_session_id
      // The store key always wins over an alias: a real key is never shadowed by a header id.
      if (native && native !== key && !source.has(native)) this.aliases.set(native, key)
    }
  }

  override get(id: string): SessionMeta | undefined {
    const own = super.get(id)
    if (own) return own
    const key = this.aliases.get(id)
    return key === undefined ? undefined : super.get(key)
  }

  override has(id: string): boolean {
    return super.has(id) || this.aliases.has(id)
  }
}

/** `metas`, additionally answering to each session's `native_session_id`. */
export function withNativeAliases(metas: ReadonlyMap<string, SessionMeta>): Map<string, SessionMeta> {
  return new AliasedMetas(metas)
}
