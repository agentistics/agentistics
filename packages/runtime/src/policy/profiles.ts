/**
 * policy/profiles.ts — the three BUILT-IN permission profiles (B4.7, B8 draft §5.5).
 *
 * A profile is an ordinary `PolicyLayer` (`./rules.ts`), inserted BETWEEN the user and project
 * layers. Nothing here is a new mechanism: every verdict still runs floor → rules → defaults in
 * `./policy.ts`, so a profile can do exactly what a rule can do and nothing more. In particular it
 * cannot lift the floor — the floor is checked before any rule is read — and there is no "bypass"
 * profile, because no rule can express one. No catalogue loading here: the three are compiled in.
 *
 * - `default` — no rules. A policy built with no profile is this one.
 * - `plan` — DENY every `write` part (so `file.write`, `file.patch` and every shell redirection to
 *   a file) and every shell segment whose leading argv tokens are on the mutating list below. Deny
 *   is absolute in `rules.ts`, so no user or project allow re-opens them. A segment the parser
 *   cannot read (opaque) still ASKS, as it does everywhere; a command on NEITHER list takes the
 *   ordinary class default (`ask` for the shell) — the profile never ALLOWS anything.
 * - `accept-edits` — ALLOW `file.write` / `file.patch` without asking, and only where the defaults
 *   would otherwise have asked: the rule names the TOOL alone (specificity [0,0,1]) and no
 *   `pathGlob`, which is deliberate on three counts:
 *     1. OUTSIDE the workspace stays a denial — `policy.ts` lifts `outside-workspace` only for a
 *        rule that NAMES the path;
 *     2. a secret-shaped file (`.env*`, `*.pem`, `id_*`, B3-SEC F4) still asks — only a rule whose
 *        own `pathGlob` names such a file lifts that;
 *     3. a person's explicit ASK on writes (`{tool:'file.write'}` or `{action:'write'}`) ties on
 *        specificity and `ask` beats `allow` at a tie — the profile lifts the DEFAULT, not somebody's
 *        rule. (A match-everything ask with NO field set, which `lintLayers` already flags, is the one
 *        rule it outranks.)
 *
 * ## How `plan` sees past a flag spelling
 *
 * `commandPrefix` matches argv TOKENS from position 0 (`rules.ts`), so on its own a user ALLOW rule
 * would have let `git -C dir commit`, `sed -i.bak` or `find . -delete` run under `plan`. The policy
 * therefore matches deny/ask rules against CANONICAL stages as well (`ruleStages`, `policy.ts`): git
 * with its global options skipped (B3's own `gitSubcommandIndex`), any in-place `sed` as `sed -i`, and
 * a writing `find` action as `find <action>`. That only ever ADDS stages for deny/ask, never for allow.
 * Remaining, stated: an arbitrary build script or interpreter (`make`, `npm run x`, `python y.py`) is
 * not on the list and takes the class default (ask) — a user ALLOW for it lets it run under `plan`.
 * Read-or-write verbs (`git branch`, `git tag`, `git stash`, `git remote`) are deliberately absent,
 * so their read forms keep working.
 *
 * ## Switching (§5.5)
 *
 * Strictness order: `accept-edits` (0) < `default` (1) < `plan` (2). `accept-edits` is LOOSER than
 * `default` (it answers questions `default` asks); `plan` is STRICTER (it refuses things `default`
 * asks about). Session approvals SURVIVE a switch to a stricter or the same profile and are DROPPED
 * on a switch to a looser one: something a person approved while in `plan` must not quietly become
 * standing permission once the session is in `accept-edits`. The switch changes nothing else.
 *
 * PURE.
 */

import type { SessionApproval } from './policy.ts'
import type { PolicyLayer, PolicyRule } from './rules.ts'

export type ProfileId = 'default' | 'plan' | 'accept-edits'

export const PROFILE_IDS: readonly ProfileId[] = ['default', 'plan', 'accept-edits']

/** Higher is stricter. */
export const PROFILE_STRICTNESS: Readonly<Record<ProfileId, number>> = { 'accept-edits': 0, default: 1, plan: 2 }

/** Leading argv tokens of a shell segment `plan` refuses: it changes files, the repository or processes. */
const PLAN_MUTATING_PREFIXES: readonly (readonly string[])[] = [
  ['rm'], ['rmdir'], ['unlink'], ['shred'], ['truncate'],
  ['mv'], ['cp'], ['ln'], ['install'], ['touch'], ['mkdir'], ['mkfifo'], ['mknod'],
  ['chmod'], ['chown'], ['chgrp'], ['setfacl'],
  ['dd'], ['tee'], ['patch'], ['rsync'],
  ['sed', '-i'], ['sed', '--in-place'], ['perl', '-i'], ['perl', '-pi'],
  ...['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'].map(a => ['find', a]),
  ['kill'], ['pkill'], ['killall'],
  ...[
    'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'fetch', 'gc', 'init',
    'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'switch', 'update-ref',
  ].map(sub => ['git', sub]),
  ...['install', 'i', 'ci', 'uninstall', 'remove', 'update', 'publish', 'link'].map(v => ['npm', v]),
  ...['install', 'i', 'add', 'remove', 'update', 'publish', 'link'].map(v => ['pnpm', v]),
  ...['install', 'add', 'remove', 'upgrade', 'publish', 'link'].map(v => ['yarn', v]),
  ...['install', 'i', 'add', 'remove', 'update', 'publish', 'link'].map(v => ['bun', v]),
  ...['install', 'uninstall'].flatMap(v => [['pip', v], ['pip3', v]]),
  ['cargo', 'install'], ['cargo', 'publish'], ['go', 'install'], ['go', 'get'],
]

function planRules(): PolicyRule[] {
  const rules: PolicyRule[] = [{ id: 'profile.plan.deny-write', effect: 'deny', match: { action: 'write' } }]
  for (const prefix of PLAN_MUTATING_PREFIXES) {
    rules.push({ id: `profile.plan.deny-${prefix.join('-')}`, effect: 'deny', match: { action: 'shell', commandPrefix: [...prefix] } })
  }
  return rules
}

export const BUILTIN_PROFILES: Readonly<Record<ProfileId, PolicyLayer>> = {
  default: { name: 'profile:default', rules: [] },
  plan: { name: 'profile:plan', rules: planRules() },
  'accept-edits': {
    name: 'profile:accept-edits',
    rules: [
      { id: 'profile.accept-edits.write', effect: 'allow', match: { tool: 'file.write' } },
      { id: 'profile.accept-edits.patch', effect: 'allow', match: { tool: 'file.patch' } },
    ],
  },
}

/** The layer for `id`. Throws, in words, on an id that is not a built-in — a typo must not run as `default`. */
export function profileLayer(id: ProfileId): PolicyLayer {
  if (!Object.prototype.hasOwnProperty.call(BUILTIN_PROFILES, id)) {
    throw new Error(`unknown permission profile "${String(id)}": the built-ins are ${PROFILE_IDS.join(', ')}`)
  }
  return BUILTIN_PROFILES[id]
}

/**
 * `layers` with the profile's layer inserted before the one named `project` (after every other
 * layer when there is none). `default` has no rules and inserts nothing.
 */
export function withProfile(layers: readonly PolicyLayer[], id: ProfileId): PolicyLayer[] {
  const layer = profileLayer(id)
  if (layer.rules.length === 0) return [...layers]
  const at = layers.findIndex(l => l.name === 'project')
  const out = [...layers]
  out.splice(at === -1 ? out.length : at, 0, layer)
  return out
}

export type ProfileSwitchDirection = 'stricter' | 'looser' | 'same'

export interface ProfileSwitch<A extends SessionApproval = SessionApproval> {
  /** Stable code a host can journal the switch under. */
  code: 'policy.profile.switched'
  from: ProfileId
  to: ProfileId
  direction: ProfileSwitchDirection
  kept: A[]
  dropped: A[]
}

/** The survive/drop rule for session approvals. Pure: the input array is not touched. */
export function switchProfile<A extends SessionApproval>(from: ProfileId, to: ProfileId, sessionApprovals: readonly A[]): ProfileSwitch<A> {
  profileLayer(from)
  profileLayer(to)
  const d = PROFILE_STRICTNESS[to] - PROFILE_STRICTNESS[from]
  const direction: ProfileSwitchDirection = d > 0 ? 'stricter' : d < 0 ? 'looser' : 'same'
  const all = [...sessionApprovals]
  return direction === 'looser'
    ? { code: 'policy.profile.switched', from, to, direction, kept: [], dropped: all }
    : { code: 'policy.profile.switched', from, to, direction, kept: all, dropped: [] }
}
