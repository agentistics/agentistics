/**
 * modelGroups.ts — PURE: how a model picker groups a list of `provider/model` ids.
 *
 * `opencode models` lists every connected provider in one flat list (`opencode/…`, `opencode-go/…`,
 * `ollama/…`), so a subscriber saw thirty ids with no way to tell which provider billed them. A list
 * is grouped only when its ids carry MORE THAN ONE provider prefix: a single-vendor list (Claude's
 * `opus`, `sonnet`) has nothing to group by and stays flat — adding a heading over every row there
 * would be noise. Order inside a group is the list's own order, except that a model that trains on
 * the user's data goes LAST in its group, so it is never the first row someone reaches for.
 */

export interface ModelGroup<T extends { id: string }> {
  /** The provider prefix, or `''` for ids with none. */
  provider: string
  options: T[]
}

/** The provider part of `provider/model`, or `''` when the id has no slash. */
export function providerOf(id: string): string {
  const i = id.indexOf('/')
  return i > 0 ? id.slice(0, i) : ''
}

/**
 * Models whose provider states that prompts and code are used for training. Owner rule: they are
 * never offered as if they were safe for private code. Matched on the bare model name, so the
 * `-contributor` suffix and any provider prefix do not matter.
 */
export function trainsOnData(id: string): boolean {
  const name = id.slice(id.indexOf('/') + 1).toLowerCase()
  return name.startsWith('muse-spark')
}

/** The groups, in the order each provider first appears; `null` when the list is not worth grouping. */
export function groupModels<T extends { id: string }>(options: T[]): ModelGroup<T>[] | null {
  const providers = new Set(options.map(o => providerOf(o.id)))
  if (providers.size < 2) return null
  const groups = new Map<string, T[]>()
  for (const o of options) {
    const p = providerOf(o.id)
    const list = groups.get(p)
    if (list) list.push(o)
    else groups.set(p, [o])
  }
  return [...groups].map(([provider, list]) => ({
    provider,
    options: [...list.filter(o => !trainsOnData(o.id)), ...list.filter(o => trainsOnData(o.id))],
  }))
}
