/**
 * ONE rule for "does this person have release versions at all?". Many people work outside a git repository or have
 * no release CI, so a version filter, a "12 versions" count or a versions strip would be an empty box for them.
 *
 * A version is REAL when a release actually shipped under it (`state: 'published'`) and it reads as x.y.z.
 * A label that only names where a piece is headed (`planned`, an estimate, `next`) is not evidence of a release
 * pipeline, so it alone never turns the version UI on. Read by the Calendar and the Live.
 */
export interface VersionLike { version: string; state: 'published' | 'planned' }

const SEMVER = /^\d+\.\d+\.\d+/

export function isRealVersion(v: VersionLike): boolean {
  return v.state === 'published' && SEMVER.test(v.version)
}

export function hasRealVersions(versions: readonly VersionLike[] | null | undefined): boolean {
  return !!versions && versions.some(isRealVersion)
}
