/**
 * backup-plan.ts — PURE. What a backup carries, and what it refuses to carry.
 *
 * Two things live here and nowhere else.
 *
 * **The layer model.** A backup is up to four layers, each independently selectable and each
 * recorded in the manifest, so a restore knows what it is holding rather than inferring it from
 * what it happens to find. `metrics` is not optional: a backup without it restores nothing.
 *
 * **The exclusion table, with a reason per row.** Three reasons, and they are not
 * interchangeable:
 *
 *  - `secret` — a live credential. Excluded by decision: a tarball holding these is a master key
 *    to the user's accounts, and it travels on a pendrive. The cost (five minutes of re-login) is
 *    paid deliberately, and `omittedSecrets()` is what lets the restore NAME each one and the
 *    command that re-establishes it. Nothing here goes missing in silence.
 *  - `regenerable` — a cache or a log. It rebuilds itself and costs megabytes.
 *  - `runtime` — true on the old machine and false on the new one. `managed-sessions.json` names
 *    tmux sessions that will not exist; restoring it produces a fleet of rows pointing at nothing.
 *
 * `backup-plan.test.ts` greps this file and re-probes every credential path, so a rule deleted in
 * a refactor fails the build rather than shipping a leak.
 */
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'

export type BackupLayer = 'metrics' | 'repos' | 'archive' | 'raw'

/** Every layer, metrics first because it is the one that is never optional. */
export const BACKUP_LAYERS: BackupLayer[] = ['metrics', 'repos', 'archive', 'raw']

/**
 * `metrics` is never optional — every writer of `backup.layers` / `backup.scheduleLayers` runs its
 * input through this before it reaches `writePreferences`, so a surface (the cockpit's layer
 * editor, the web format picker, `agentop backup config`) cannot silently drop it by sending a list
 * that omits it. Also normalizes ORDER to `BACKUP_LAYERS`, so a preference written by any of the
 * three always reads back in the one order every surface already expects.
 */
export function withMetrics(layers: BackupLayer[]): BackupLayer[] {
  const set = new Set(layers)
  set.add('metrics')
  return BACKUP_LAYERS.filter(l => set.has(l))
}

export type ExcludeReason = 'secret' | 'regenerable' | 'runtime'

export interface ExcludeRule {
  /** Matched against a $HOME-relative path with no leading slash. */
  pattern: string
  /**
   * `prefix` — the path STARTS WITH `pattern`. A string prefix, deliberately, not a directory
   * boundary: three rules depend on it matching a filename STEM rather than a directory
   * — `.agentistics/cache.db` must catch `cache.db-wal` and `cache.db-shm`, `.agentistics/git-stats.db`
   * the same, and `.agentistics/server.lock` must be caught. A boundary check would let
   * all of those through.
   *
   * The cost is that a path merely sharing a string prefix is excluded too (a hypothetical
   * `.claude/statsigmoid.json` would match the `.claude/statsig` rule). That direction is
   * over-exclusion, never a credential leak, which is the trade this filter must make: a file
   * wrongly kept out of a backup is recoverable, a credential wrongly let in is not.
   *
   * `contains` — `pattern` appears anywhere in the path.
   */
  match: 'prefix' | 'contains'
  reason: ExcludeReason
  /** For `secret` only: the command that re-establishes it. Required, and tested for. */
  restoreWith?: string
  /** Why this row exists. Rendered by `agentop backup --explain`. */
  why: string
}

/**
 * Credential paths, per harness.
 *
 * A Record, so a new harness cannot be added without a decision about its secrets — the same rule
 * `HARNESS_SORT` enforces for display order, applied to the one table where forgetting a harness
 * puts a key in a tarball. An empty array is a legitimate entry and means "this harness stores no
 * credential under its own directory"; it is a claim, so state the evidence in a comment.
 */
export const HARNESS_SECRETS: Record<HarnessId, ExcludeRule[]> = {
  claude: [
    {
      pattern: '.claude/.credentials.json', match: 'prefix', reason: 'secret',
      restoreWith: 'claude login',
      why: 'Claude Code OAuth credentials — a live session token.',
    },
    {
      pattern: '.claude/agentistics-preferences.json', match: 'prefix', reason: 'secret',
      restoreWith: 'agentop member connect <url> <token>',
      why: 'A copy of the agentistics preferences that sits under the Claude directory and holds `team.token`, the member token for a central. The redacted `.agentistics/preferences.json` travels instead (see ALWAYS); this copy is not staged, so it would carry the token verbatim.',
    },
  ],
  codex: [
    {
      pattern: '.codex/auth.json', match: 'prefix', reason: 'secret',
      restoreWith: 'codex login',
      why: 'Codex CLI credentials, including the id token whose payload carries the tier.',
    },
  ],
  gemini: [
    {
      pattern: '.gemini/oauth_creds.json', match: 'prefix', reason: 'secret',
      restoreWith: 'gemini  (sign in on first run)',
      why: 'Gemini CLI OAuth credentials.',
    },
    {
      pattern: '.gemini/gemini-credentials.json', match: 'prefix', reason: 'secret',
      restoreWith: 'gemini  (sign in on first run)',
      why: 'A second Gemini credential file the oauth_creds rule does not reach — verified present on a real machine.',
    },
    {
      pattern: '.gemini/google_accounts.json', match: 'prefix', reason: 'secret',
      restoreWith: 'gemini  (sign in on first run)',
      why: 'The signed-in Google account identifiers.',
    },
  ],
  copilot: [
    {
      pattern: '.copilot/token', match: 'contains', reason: 'secret',
      restoreWith: 'copilot  (sign in on first run)',
      why: 'Copilot CLI token files.',
    },
    {
      pattern: '.copilot/mcp-oauth-config', match: 'prefix', reason: 'secret',
      restoreWith: 're-authorise each MCP server from inside copilot',
      why: 'Per-MCP-server OAuth tokens. The `.copilot/token` rule does not reach `mcp-oauth-config/<x>.tokens.json`.',
    },
    {
      pattern: '.copilot/config.json', match: 'prefix', reason: 'secret',
      restoreWith: 'copilot  (sign in on first run)',
      why: 'Holds `copilotTokens` (a credential) alongside ordinary settings. The whole file is excluded: over-excluding costs the user their Copilot settings, which are recoverable, while under-excluding costs them a token, which is not. Neither `.copilot/token` nor `.copilot/mcp-oauth-config` reaches it.',
    },
  ],
  antigravity: [
    {
      pattern: '.gemini/antigravity-cli/antigravity-oauth-token', match: 'prefix', reason: 'secret',
      restoreWith: 'agy  (sign in on first run)',
      why: 'Antigravity OAuth token. It lives under the Gemini directory, so no Gemini rule reaches it.',
    },
  ],
  kimi: [
    {
      pattern: '.kimi-code/config.toml', match: 'prefix', reason: 'secret',
      restoreWith: 'restore your api_key in ~/.kimi-code/config.toml',
      why: 'Holds `api_key` alongside ordinary settings. The whole file is excluded: over-excluding costs the user their Kimi settings, which are recoverable, while under-excluding costs them a key, which is not.',
    },
  ],
  // opencode's OWN store (`opencode.db`, under RAW_DIR below) has `account`/`control_account`/
  // `credential` tables with `access_token`/`refresh_token`/`value` columns — a live OAuth token,
  // in the SAME file as the conversation history this backup exists to carry. Both real
  // sessions/tables measured for this integration were 0 rows, so there is nothing to redact on
  // THIS machine, but the exclusion model here is per-FILE (a path pattern) and a single SQLite
  // file mixing valuable history with a credential table cannot be split by one — so, following
  // this module's own stated bias ("a file wrongly kept out of a backup is recoverable, a
  // credential wrongly let in is not"), the WHOLE file is excluded rather than guessed at, exactly
  // as the whole of kimi's config.toml is excluded above for the same reason. This costs the
  // opencode conversation history a backup captures for every other harness — a real product
  // trade-off, stated here for a human owner to revisit once/if this is worth a finer-grained
  // (row-level) redaction step.
  opencode: [
    {
      pattern: '.local/share/opencode/opencode.db', match: 'prefix', reason: 'secret',
      restoreWith: 'opencode auth login (re-authenticate any provider you had connected)',
      why: 'The whole session-history database, because its account/credential tables carry OAuth tokens and this exclusion model cannot split one file into a safe part and a secret part. Over-excluding costs the user their opencode conversation history, which is recoverable by using opencode again; under-excluding costs them a live token, which is not.',
    },
  ],
}

/** Secrets that are not scoped to one harness. */
const CROSS_HARNESS_SECRETS: ExcludeRule[] = [
  {
    pattern: '.agentistics/connections', match: 'prefix', reason: 'secret',
    restoreWith: 'agentop member connect <url> <token>',
    why: 'Per-central member tokens. team-tokens.ts stores only hashes centrally; this is the token itself.',
  },
  {
    pattern: '.agentistics/machine-key', match: 'prefix', reason: 'secret',
    restoreWith: 'nothing — siblings re-pin this machine on its next announcement',
    why: 'The X25519 private key behind the sealed envelope channel (envelope-keys.ts, 0600, never logged).',
  },
  // This pattern can never match a real path — a `#` never appears in any filename this walks — so
  // it excludes nothing new. It exists only so `omittedSecrets()` names the tokens inside
  // `preferences.json` for the restore to print; the file itself is never walked at all (see
  // `ALWAYS`, above) because it travels REDACTED, staged by `cli-backup.ts`.
  {
    pattern: '.agentistics/preferences.json#team.token', match: 'prefix', reason: 'secret',
    restoreWith: 'agentop member connect <url> <token>',
    why: 'The central tokens inside preferences.json. The file itself travels, redacted — see backup-plan.ts ALWAYS.',
  },
  {
    // The trailing dot is deliberate: it covers the sealed file (`github-backup.sealed`), the legacy
    // plaintext one (`github-backup.json`) and either one's crash leftovers, and nothing else.
    pattern: '.agentistics/github-backup.', match: 'prefix', reason: 'secret',
    restoreWith: 'agentop backup github setup <url>',
    why: 'The GitHub PAT used to upload versioned backups (github-store.ts, sealed by the vault). A backup-'
      + 'configuration file holding a key and living where the backups live is exactly what this '
      + 'table exists to keep out of an archive.',
  },
  {
    pattern: '.agentistics/provider-keys', match: 'prefix', reason: 'secret',
    restoreWith: 'agentop provider key set anthropic',
    why: 'Provider API keys entered for the native runtime (credentials.ts, 0600, never logged).',
  },
  {
    pattern: '.agentistics/content', match: 'prefix', reason: 'secret',
    restoreWith: 'nothing — the captures are evidence of calls made on this machine and expire with it',
    why: 'The content store (context-manager spec §8.1/§8.3): raw provider responses captured per '
      + 'attempt by @agentistics/runtime (provider/capture.ts), 0600. Raw model output can echo anything the model read — a '
      + 'token printed by a tool included — so it is excluded by default like a credential, not '
      + 'carried and hoped clean.',
  },
  // `.claude/sessions/<pid>.<hash>.key` (141 files on the reference machine) and
  // `.claude/daemon/control.key` are local control-socket tokens for the session manager and the
  // daemon dispatch socket. Both the `secret` and `runtime` reasons apply — they are credential-
  // shaped AND tied to pids that will not exist on the new machine either way — and the table's own
  // trade (over-exclusion is cheap, a leaked token is not) says they go out. `.key` alone is enough:
  // it is a `contains` match, and nothing else this walk ever produces carries that extension.
  // ── Everything else agentop writes under ~/.agentistics ─────────────────────────────────────
  // Each of these was UNDECIDED — neither carried nor excluded — which is a silent omission: the
  // file is not in the archive, nothing says so, and the loss is found on the machine that no
  // longer has the original. `backup-coverage.lint.test.ts` now fails on any new one.
  {
    pattern: '.agentistics/vault', match: 'prefix', reason: 'secret',
    restoreWith: 'agentop vault init (runs on first use)',
    why: 'The wrapped data key that opens every sealed secret on this machine (vault/service.ts). '
      + 'Useless off this machine except the passphrase wrapper, which is an offline brute-force '
      + 'target beside the files it opens — so the DIRECTORY never travels. The vault goes instead as '
      + 'ONE sealed bundle beside the archive (vault-bundle.json, VAULT.PERSONAL): every record still '
      + 'sealed, the key only under the 24-word recovery wrapper, no machine-bound wrapper. A restore '
      + 'stages it and the 24 words open it; without a bundle, a new vault is created on first use.',
  },
  {
    pattern: '.agentistics/central', match: 'prefix', reason: 'secret',
    restoreWith: 'agentop central up',
    why: 'central.env holds AGENTISTICS_TEAM_PASSWORD, the session secret, the ingest token and '
      + 'MONGO_URL. The compose file beside it is generated by `agentop central up`, so the whole '
      + 'directory goes out and nothing of value is lost with it.',
  },
  {
    pattern: '.agentistics/team', match: 'prefix', reason: 'secret',
    restoreWith: 'agentop central up (a central rebuilds it) — nothing on a member or solo machine',
    why: 'A central\'s own server state (TEAM_DIR). It belongs to the central this machine IS, not '
      + 'to the metrics it collected, and it sits beside credentials.',
  },
  {
    pattern: '.agentistics/run', match: 'prefix', reason: 'runtime',
    restoreWith: 'nothing — the running service recreates it',
    why: 'The vault\'s unlock socket (`run/vault.sock`), live only while an agentop service runs.',
  },
  {
    pattern: '.agentistics/backups', match: 'prefix', reason: 'runtime',
    restoreWith: 'nothing — these ARE the backups',
    why: 'The archives themselves, and `backups.jsonl`, whose records name local paths that will '
      + 'not exist on the machine being restored. A backup carrying every previous backup grows by '
      + 'its own history until it cannot be uploaded.',
  },
  {
    pattern: '.agentistics/events.jsonl', match: 'prefix', reason: 'runtime',
    restoreWith: 'nothing — the producer fills a fresh inbox',
    why: 'The event inbox (0600) and its rotations. Every record is about a session on THIS '
      + 'machine, named by ids the new machine will not have.',
  },
  {
    pattern: '.agentistics/restore-state.json', match: 'prefix', reason: 'runtime',
    restoreWith: 'nothing — `agentop restore --repos` writes its own',
    why: 'The resumable plan of a restore in progress. Carrying one INTO an archive would have a '
      + 'restore resume a plan belonging to a different machine.',
  },
  {
    pattern: '.agentistics/upgrade.lock', match: 'prefix', reason: 'runtime',
    restoreWith: 'nothing',
    why: 'A lock held by a process on this machine.',
  },
  {
    pattern: '.agentistics/team-sent.json', match: 'prefix', reason: 'regenerable',
    restoreWith: 'nothing — the uploader re-pushes its full history on the next cycle',
    why: 'What this machine has already pushed to a central, plus team-sync.json beside it. The '
      + 'uploader reconciles by sync fingerprint and re-sends everything when the target changes '
      + '(idempotent upserts), which is exactly the state a restored machine is in.',
  },
  {
    pattern: '.agentistics/login-env.json', match: 'prefix', reason: 'regenerable',
    restoreWith: 'nothing — the next session spawn re-resolves it from the login shell',
    why: 'The last good login-shell PATH and toolchain locations (sessions/login-env.ts). They '
      + 'describe THIS machine\'s directories, so restoring them onto another one would be wrong.',
  },
  {
    pattern: '.agentistics/team-sync.json', match: 'prefix', reason: 'regenerable',
    restoreWith: 'nothing — reconciled on the next push',
    why: 'See team-sent.json.',
  },
  {
    pattern: '.agentistics/nay-chat', match: 'prefix', reason: 'regenerable',
    restoreWith: 'nothing — the server rewrites it on every start',
    why: 'A scratch working directory for the chat feature. `chat-tty.ts` writes its CLAUDE.md and '
      + '.claude/ on EVERY server start, so a restored copy would be overwritten within seconds.',
  },
  {
    pattern: '.agentistics/claude-chat', match: 'prefix', reason: 'regenerable',
    restoreWith: 'nothing — nothing reads it any more',
    why: 'LEGACY: the scratch directory of the removed /api/claude-chat route. The server no longer '
      + 'creates it, but machines that ran an older build still have one, so it stays decided.',
  },
  {
    pattern: '.agentistics/version-cache.json', match: 'prefix', reason: 'regenerable',
    restoreWith: 'nothing — refreshed by the next update check',
    why: 'A cache of the latest published version.',
  },
  {
    pattern: '.agentistics/upgrade-progress.json', match: 'prefix', reason: 'runtime',
    restoreWith: 'nothing',
    why: 'What an upgrade running on THIS machine says about itself, read by the page that started '
      + 'it. It describes a process and a binary the new machine does not have.',
  },
  {
    pattern: '.agentistics/upgrade-failure.json', match: 'prefix', reason: 'regenerable',
    restoreWith: 'nothing',
    why: 'Why the last upgrade on THIS machine failed. It describes a binary the new machine does '
      + 'not have.',
  },
  {
    pattern: '.agentistics/journal.db.stamps.json', match: 'prefix', reason: 'regenerable',
    restoreWith: 'nothing — the shadow writer re-derives it by re-reading its sources',
    why: 'Which source versions the shadow writer already folded into the journal. Restored beside a '
      + 'journal that is not the one it describes, it would make the writer SKIP sources it never '
      + 'ingested there; absent, it re-reads and the journal dedupes.',
  },
  {
    pattern: '.agentistics/journal.db.backfill.json', match: 'prefix', reason: 'regenerable',
    restoreWith: 'nothing — the automatic first import writes it again as it runs',
    why: "The automatic first import's progress (state, counts, when it completed), bound to the "
      + 'identity of the journal file it describes. Restored beside a different journal it is ignored, '
      + 'and the import runs again; the journal dedupes.',
  },
  {
    pattern: '.agentistics/journal.db.import.json', match: 'prefix', reason: 'regenerable',
    restoreWith: 'nothing — `agentop journal import` re-derives it by re-reading its sources',
    why: "`agentop journal import`'s resume state: a cursor per replayed source and the store entries "
      + 'already imported, bound to the identity of the journal file it describes. Restored beside a '
      + 'different journal it is ignored; absent, the import re-reads and the journal dedupes.',
  },
  {
    pattern: '.agentistics/projections.db', match: 'prefix', reason: 'regenerable',
    restoreWith: 'nothing — the next catch-up pass rebuilds every projection from the journal',
    why: 'The materialised projections (P3): fold states, finished rows and cursors DERIVED from '
      + '`journal.db`, which IS carried. Its cursors are rowids of THIS machine\'s journal, so restored '
      + 'beside another they would describe events that are not there; absent, a rebuild re-derives it. '
      + 'The prefix also catches its `-wal` / `-shm`.',
  },
  {
    pattern: '.agentistics/auto-upgrade.log', match: 'prefix', reason: 'regenerable',
    restoreWith: 'nothing',
    why: 'A log.',
  },
  {
    pattern: '.agentistics/agentop-central.log', match: 'prefix', reason: 'regenerable',
    restoreWith: 'nothing',
    why: 'A log.',
  },
  {
    pattern: '.key', match: 'contains', reason: 'secret',
    restoreWith: 'nothing — a live session or the daemon issues a fresh one',
    why: 'Local control-socket tokens: .claude/sessions/<pid>.<hash>.key and .claude/daemon/control.key.',
  },
]

const REGENERABLE: ExcludeRule[] = [
  {
    pattern: '.agentistics/cache.db', match: 'prefix', reason: 'regenerable',
    why: 'Parse cache. Rebuilt on the next build; 2.3 MB on the reference machine.',
  },
  {
    pattern: '.agentistics/git-stats.db', match: 'prefix', reason: 'regenerable',
    why: 'Git stats cache, keyed on commit. Rebuilt by walking git again.',
  },
  {
    pattern: '.agentistics/agentop-server.log', match: 'prefix', reason: 'regenerable',
    why: 'Server log. 6.2 MB on the reference machine and true of a machine that no longer exists.',
  },
  {
    pattern: '.corrupt-', match: 'contains', reason: 'regenerable',
    why: 'Quarantined copies the registry wrote when it could not parse a file.',
  },
  {
    pattern: '.tmp-', match: 'contains', reason: 'regenerable',
    why: 'Half-written temp files from an interrupted atomic write.',
  },
  {
    pattern: '.claude/shell-snapshots', match: 'prefix', reason: 'regenerable',
    why: 'Shell snapshots, recreated per session.',
  },
  {
    pattern: '.claude/paste-cache', match: 'prefix', reason: 'regenerable',
    why: 'Paste cache.',
  },
  {
    pattern: '.claude/plugins/cache', match: 'prefix', reason: 'regenerable',
    why: 'Plugin cache, re-fetched from the marketplace.',
  },
  {
    pattern: '.claude/statsig', match: 'prefix', reason: 'regenerable',
    why: 'Feature-flag cache.',
  },
]

const RUNTIME: ExcludeRule[] = [
  {
    pattern: '.agentistics/managed-sessions.json', match: 'prefix', reason: 'runtime',
    why: 'Names tmux sessions that will not exist on the new machine. Restoring it yields rows pointing at nothing.',
  },
  // Written by the ENGINE, not by this tree, so `backup-coverage.lint.test.ts` (a grep over the
  // server's own source) cannot see it — `backup-plan.test.ts` pins this row instead.
  // Written by the ENGINE (A5.1 live-ingestion hooks), like `.agentistics/runtime` below — pinned by
  // `backup-plan.test.ts`, since the coverage grep reads only this tree.
  {
    pattern: '.agentistics/ingest', match: 'prefix', reason: 'runtime',
    why: 'The hook spool (`ingest/hooks.jsonl`, 0600, and its one rotation): ids of sessions on THIS '
      + 'machine that just ended a turn, consumed by the live feeder within seconds. Restored elsewhere '
      + 'it would wake nothing; the transcripts themselves are what a backup carries.',
  },
  {
    pattern: '.agentistics/runtime', match: 'prefix', reason: 'runtime',
    why: 'The native session store (`runtime/sessions.db` and its -wal/-shm). Not `secret`: a session '
      + 'names its credential by ID, never by key, and a message row is only a sha256 + byte count '
      + 'referring into `.agentistics/content`. Not carried either: that content is itself a `secret` '
      + 'row and never travels, so every restored message would point at nothing, and each `leases` '
      + 'row names a pid (and its token) on THIS machine. Session approvals ("allow for this session") '
      + 'are not stored here at all — they live in a policy object and end with the process.',
  },
  {
    pattern: '.agentistics/journal.db.status.json', match: 'prefix', reason: 'runtime',
    why: 'A live process\'s counters since its boot, read by `agentop journal status` from another '
      + 'process. Meaningless on a machine whose writer never ran.',
  },
  {
    pattern: '.agentistics/server.lock', match: 'prefix', reason: 'runtime',
    why: 'The instance claim, held by a process on the old machine. Restoring it would make a fresh machine believe a server it does not have is already running.',
  },
  {
    pattern: '.agentistics/events-producer.json', match: 'prefix', reason: 'runtime',
    why: 'The producer heartbeat — a pid on a machine that is gone.',
  },
  {
    pattern: '.claude/daemon', match: 'prefix', reason: 'runtime',
    why: 'The daemon dispatch queue, roster and attach journal — all keyed to pids and sockets on '
      + 'THIS machine. `control.key` under this same directory is additionally caught by the `.key` '
      + 'secret rule above, which runs first.',
  },
]

export const EXCLUDE_RULES: ExcludeRule[] = [
  ...HARNESS_ORDER.flatMap(h => HARNESS_SECRETS[h]),
  ...CROSS_HARNESS_SECRETS,
  ...REGENERABLE,
  ...RUNTIME,
]

/**
 * The raw directory each harness owns, $HOME-relative.
 *
 * A Record so the compiler requires an entry per HarnessId. Note that antigravity's dir is INSIDE
 * gemini's — `planSources` drops the nested one when both are selected, or tar would walk the same
 * bytes twice and the size accounting would double-count them.
 */
const RAW_DIR: Record<HarnessId, string> = {
  claude: '.claude',
  codex: '.codex',
  gemini: '.gemini',
  copilot: '.copilot',
  antigravity: '.gemini/antigravity-cli',
  kimi: '.kimi-code',
  // Its DATA lives here; the CLI's own binary install (~/.opencode/bin) is a separate directory
  // this backup has no reason to carry (a binary is reinstallable; the auth.json beside it there is
  // also outside this dir, so this raw dir does not reach it either).
  opencode: '.local/share/opencode',
}

/** Cross-harness data. Always included: a backup without these restores metrics that no filter,
 *  tag, layout or billing basis can interpret. */
const ALWAYS: string[] = [
  '.agentistics/tags.json',
  '.agentistics/workflows',
  // NOT here, deliberately. `preferences.json` travels REDACTED, staged by `cli-backup.ts`, because
  // it carries live central tokens (`team.token` and `team.connections[].token`) that exist nowhere
  // else on this machine. Walking it would put them in the archive verbatim — in the 4 MB default
  // backup the design says is safe to schedule and carry on a pendrive.
  '.agentistics/notifications.json',
  // The notification history a CENTRAL keeps, the twin of the file above
  // (`notifications-store.ts` picks one by mode). Both or neither: a machine that is a central
  // today and a member tomorrow would otherwise lose whichever half it was not when the backup ran.
  '.agentistics/notifications-central.json',
  // The event channel's subscriptions: which task, which transitions, who is notified, the note a
  // person wrote on each. That is CONFIGURATION somebody sat down and made — it exists in no other
  // file and nothing regenerates it — and it was missing from the backup until
  // `backup-coverage.lint.test.ts` was written to make an undecided path impossible.
  '.agentistics/event-subscriptions.json',
  // Images and files attached to sessions from the web (`sessions/attachment-web.ts`). User
  // content, referenced by sessions that DO travel, and reproducible from nowhere: 97 files / 12 MB
  // on the reference machine. It grows, which is an argument for watching it, not for dropping it —
  // the layer's own size accounting reports it like everything else.
  '.agentistics/attachments',
  // The task BOARD. Titles, descriptions, comments, subtasks, blockers, links, priorities, the
  // claim state and the activity log — every word of it typed by a person or written by an agent
  // working for one, and reproducible from nothing: the sessions it measures survive, but which
  // work they were FOR does not exist anywhere else. Tens of KB.
  '.agentistics/tasks.json',
  // The files attached to those tasks — specs, plans, screenshots pasted into a comment. Same
  // argument as `attachments` above: user content, referenced by records that DO travel, and gone
  // for good if the machine is. It grows, which is an argument for watching it in the size
  // accounting rather than for leaving it behind.
  '.agentistics/task-files',
  // The index that makes those attachments findable again: which session each was typed
  // into, and when (`attachment-web.ts`'s ATTACHMENT_LOG). It travels WITH them for the
  // obvious reason — restoring the images and losing the record would put every
  // `[Image #N]` back to a chip on the restored machine, which is the defect the record
  // exists to fix. Kilobytes: one line per file.
  '.agentistics/attachment-sends.jsonl',
  // The durable event journal (P1 §6, decision D2). `metrics`, included: its whole point is
  // surviving the harness's own 30-day cleanup, so once a transcript is gone the journal is the
  // ONLY copy of those events — nothing regenerates it. STATED LIMITS, both for a follow-up rather
  // than A1.3: (1) `walkSources` copies a file source as exactly that file, so events committed to
  // `journal.db-wal` and not yet checkpointed into the main file (SQLite checkpoints every ~1000
  // pages) are NOT in the archive; (2) it is a file copy of a live WAL database, not an SQLite
  // online backup, so a copy racing a checkpoint can be torn. A consistent snapshot (`VACUUM INTO`
  // staged like `preferences.json`) answers both. A journal moved by `AGENTISTICS_JOURNAL_DIR`
  // outside the data dir is not under this path and does not travel.
  '.agentistics/journal.db',
  // Claude's deep aggregate. It is the only surviving source of pre-30-day totals once Claude
  // Code's own cleanup has run, and it is 24 KB.
  '.claude/stats-cache.json',
]

export interface PlanInput {
  layers: BackupLayer[]
  harnesses: HarnessId[]
}

export interface SourceEntry {
  /** $HOME-relative, no leading slash. */
  rel: string
  layer: BackupLayer
  /** null when the entry is cross-harness. */
  harness: HarnessId | null
}

/** The exclusion rule that covers `rel`, or null. First match wins. */
export function excludeFor(rel: string): ExcludeRule | null {
  for (const r of EXCLUDE_RULES) {
    if (r.match === 'contains') {
      if (rel.includes(r.pattern)) return r
    } else if (rel.startsWith(r.pattern)) {
      return r
    }
  }
  return null
}

/** Every secret rule, for the sentence the restore prints. */
export function omittedSecrets(): ExcludeRule[] {
  return EXCLUDE_RULES.filter(r => r.reason === 'secret')
}

/** Is `rel` inside `parent` (or equal to it)? */
function within(rel: string, parent: string): boolean {
  return rel === parent || rel.startsWith(parent + '/')
}

/**
 * The sources a backup walks, deduplicated.
 *
 * `metrics` is added whatever the caller asked for. The harness selection scopes two things — the
 * consolidate dir and the raw dir — and nothing else: the cross-harness files are the vocabulary
 * the metrics are read in. The `repos` layer contributes no source here; its content is produced
 * during the backup and lives nowhere in $HOME — a later task carries it into the archive through
 * a separate route.
 */
export function planSources(input: PlanInput): SourceEntry[] {
  const layers = new Set<BackupLayer>([...input.layers, 'metrics'])
  // Order by HARNESS_ORDER so the walk, the sizes and the manifest all list harnesses the same way.
  const harnesses = HARNESS_ORDER.filter(h => input.harnesses.includes(h))
  const out: SourceEntry[] = []

  if (layers.has('metrics')) {
    for (const h of harnesses) out.push({ rel: `.agentistics/sessions/${h}`, layer: 'metrics', harness: h })
    for (const rel of ALWAYS) out.push({ rel, layer: 'metrics', harness: null })
  }
  if (layers.has('archive')) out.push({ rel: '.agentistics/archive', layer: 'archive', harness: null })
  if (layers.has('raw')) {
    for (const h of harnesses) out.push({ rel: RAW_DIR[h], layer: 'raw', harness: h })
  }

  // Drop an entry that lives inside another entry of the SAME layer. Cross-layer nesting does not
  // occur (metrics and raw never overlap), and collapsing across layers would lose the layer label.
  const kept = out.filter((e, i) => !out.some((o, j) =>
    j !== i && o.layer === e.layer && o.rel !== e.rel && within(e.rel, o.rel)))

  const seen = new Set<string>()
  return kept.filter(e => {
    const key = `${e.layer}:${e.rel}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
