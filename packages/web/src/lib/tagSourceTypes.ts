/** The dimensions a tag source can name. `machine` is still READ (a tag that carries one keeps
 *  resolving and keeps its label) but is never offered: there is exactly ONE machine, so a tag
 *  built on it would cover every session — "everything", asked for in a way that reads like a real
 *  choice. */
export type TagSourceType = 'repo' | 'project' | 'machine' | 'harness' | 'model'

/** The source types the picker offers. Repo and project lead because they are what anyone actually
 *  reaches for; harness and model follow — session ATTRIBUTES, not identity. */
export const OFFERED_TAG_SOURCE_TYPES: readonly TagSourceType[] = ['repo', 'project', 'harness', 'model']
