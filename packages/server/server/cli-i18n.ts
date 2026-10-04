/**
 * cli-i18n.ts — English/Portuguese strings the HOST produces.
 *
 * The CLI is English by default. The language follows `preferences.lang` (shared with the web
 * toggle), an in-app toggle that persists there, or a `--lang en|pt` flag. These strings are
 * CLI-specific (the @agentistics/core i18n keys are web-focused), kept here so the control center
 * stays self-contained and bundles cleanly into the binary.
 *
 * The division of labour: everything here is something `cli-start.ts` PRODUCES — a service label, a
 * mode sentence, the outcome of an action, a line printed by a non-interactive subcommand. The
 * words the control center's own screens are made of live in `tui/src/control/i18n.ts`, because the
 * host hands the TUI a `ControlStatus`, not a string table.
 */

import type { TakeoverRefusal } from './sessions/takeover'
import type { SendNowOutcome } from '@agentistics/core'
// Mirrors of the engine's rate-limit vocabulary (its `provider/rate-limit.ts`) — the engine is no
// longer in this tree, and these strings are what the host renders its readings with.
type RateLimitResourceKind = 'requests' | 'tokens' | 'input-tokens' | 'output-tokens' | 'project-tokens'
type RateLimitAbsentReason = 'not-documented' | 'unknown-format' | 'no-headers' | 'unparseable'
import type { EngineAbsentReason, EngineCommand, EngineStatus } from '@agentistics/engine-api'

/** A verb an engine may answer. Recognised by every build, so a missing one is SAID, not unknown. */
export type EngineVerb = EngineCommand['verb']

/*
 *
 * The flat arrow-key launcher this file was written for is gone, and with it forty entries that
 * named its menu items and its "stop which?" submenus. They were deleted rather than left in place:
 * a string table is documentation of what the program can say, and entries for a menu that no
 * longer exists document a program that no longer exists.
 */

export type CliLang = 'en' | 'pt'

/** Where the official build is downloaded. */
export const OFFICIAL_BUILD_URL = 'https://github.com/agentistics/agentistics/releases'

/** What each engine verb DOES, completing "`agentop <verb>` …". */
const ENGINE_VERB_WHAT: Record<CliLang, Record<EngineVerb, string>> = {
  en: {
    code: 'runs the native harness',
    provider: "manages the native harness's provider keys",
    ingest: 'feeds live events from your harnesses into the journal',
  },
  pt: {
    code: 'roda o harness nativo',
    provider: 'gerencia as chaves de provedor do harness nativo',
    ingest: 'alimenta o journal com eventos ao vivo dos seus harnesses',
  },
}

/** The engine verbs every build recognises, in the order the help lists them. */
export const ENGINE_VERBS: readonly EngineVerb[] = ['code', 'provider', 'ingest']

/** English one-liners for `agentop --help`, used when this build's engine does not provide a verb. */
export const ENGINE_VERB_HELP: Record<EngineVerb, string> = {
  code: 'Run the native harness',
  provider: 'Manage a provider API key for the native harness',
  ingest: 'Feed live events from your harnesses into the journal',
}

/** A subject that opens a sentence (`the server on :47291` → `The server on :47291`). */
const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

export interface CliStrings {
  /** Which language this table is — for the few strings built from data, like a date. */
  lang: 'en' | 'pt'
  tagline: string
  configSolo: string
  /** The member sentence WITHOUT the endpoint, for surfaces that print the endpoint themselves. */
  configMemberBare: string
  configMember: (endpoint: string) => string
  configMembers: (n: number) => string
  configMemberLine: (endpoint: string, suffix: string) => string
  deniedSuffix: (n: number) => string
  configCentral: string
  nothingRunning: string

  confirmKill: string
  alreadyRunning: (url: string) => string
  leftRunning: string
  pauseMsg: string

  startedBg: string
  logsLabel: string
  webLabel: string
  bootLabel: string
  bootNote: string
  containerUp: string
  stoppingLocal: string
  stopNoTarget: string
  stoppingCentral: string
  stoppingMachine: string
  restartingLocal: string
  restartingCentral: string
  restartingMachine: string
  rebuildingCentral: string
  rebuildingMachine: string
  rebuildingLocal: string
  localRebuildHint: string
  localRebuildFailed: string
  /** `-y` with `-n`, or `--cache` with `--no-cache`: say which two, and refuse. */
  flagConflict: (a: string, b: string) => string
  /** Said whenever a rebuild starts a cacheless build — the slow path must never be a surprise. */
  rebuildNoCache: string
  restartedAll: string
  restartedDone: string
  /** A central/machine restart or rebuild whose docker command failed — the old (or no) container
   *  is what's actually running, and this replaces a false "restarted" banner. */
  restartFailed: string
  noComposeFrom: (dir: string) => string
  runFromRepo: string
  buildingMachine: string

  // control center — service rows, action outcomes and the reasons a state is unknown.
  // Everything the control center shows comes from the host already localized, so every sentence
  // it can print has to exist here.
  /** The browser-open outcome. */
  urlOpened: (url: string) => string
  urlOpenFailed: string

  /** The two LOGICAL service names — one row each, whichever runtime they happen to be using. */
  svcAgentistics: string
  svcCentral: string
  /**
   * More than one runtime of the same logical service is up.
   *
   * Takes the runtime words so both are NAMED: the row is painted in the danger colour, and a
   * colour on its own carries no meaning on a terminal that flattens it. It is the one service
   * state the screen must never tidy away — the two copies share the port and the files.
   *
   * The word and both names come FIRST, before the advice. The sentence is drawn into the detail
   * pane, which on a narrow terminal is under thirty columns wide and truncates from the right —
   * so a sentence that reached its second runtime at column thirty was, at exactly the sizes where
   * the services row can say least, a red line that named one runtime.
   */
  svcConflict: (runtimes: string[]) => string
  /** A second copy under the SAME runtime, serving nothing. Names the pid — see ControlService.idle. */
  svcIdleServer: (pids: number[]) => string
  actStopIdle: string
  idleStopped: (n: number) => string
  idleNoneLeft: string
  /** A stop/restart named something that is not running. */
  svcNotRunning: string

  /** The session fleet — the words the monitor's rows and detail pane wear. */
  sessState: {
    working: string
    waitingApproval: string
    waiting: string
    exited: string
    lost: string
    external: string
    closed: string
  }
  /**
   * The mark a row wears when the MAIN agent has finished its turn while something it started is
   * still running — a background subagent. Appended to the state word, never instead of it: the
   * session needs a person, and the mark only says why the harness still looks busy.
   */
  sessBackground: string
  /** Said on a session whose harness has no probed approval markers. */
  sessApprovalBlind: (harness: string) => string
  /**
   * Said on a row whose recorded DIRECTORY no longer exists on this machine.
   *
   * A removed worktree is the ordinary way to get here, and the row is still worth having — it
   * carries the name, the note and the task. What it cannot carry is a project derived from a path
   * that resolves to nothing, and this is the sentence that says so instead.
   */
  sessDirGone: string
  /**
   * Said on a hosted row whose harness can never report which conversation it is writing.
   *
   * Not "no conversation was found": the point is that none can be, so what the reopen verb offers
   * for this harness is inferred from the directory rather than recorded. See
   * `conversationLinkable`.
   */
  sessConversationBlind: (harness: string) => string
  /**
   * Said on a hosted, ENDED row of a harness whose only exact link needs the LIVE process
   * (`conversationLinkGoneForever`) and never got one — antigravity today.
   *
   * A DIFFERENT fact from `sessConversationBlind`: that one is a harness that can never report a
   * link at all, this one is a harness that can, and this particular session's one chance (this
   * machine's own several seconds right after spawn, plus every poll while it was alive) simply
   * passed before it happened — a first-run trust dialog nobody answered, most often. Once the
   * process has exited, nothing on this machine can recover the id it would have named.
   */
  sessConversationLost: (harness: string) => string
  /**
   * Said on a session that IS visibly blocked, but whose dialog nobody has read.
   *
   * A different fact from `sessApprovalBlind`, which is about not being able to SEE the block. This
   * one is about not knowing which key answers it — and a harness can have one and not the other.
   */
  sessApproveBlind: (harness: string) => string
  /** The prompt was typed in and submitted. */
  sessPrompted: (id: string) => string
  /** Refused: the session is sitting on a dialog, so typed text would answer the menu. */
  sessPromptBlocked: string
  /** Refused: nothing is running there to type into. */
  sessNotRunning: string
  /** Refused: nothing was typed. */
  sessPromptEmpty: string
  /** The backend accepted neither the text nor the key. */
  sessSendFailed: (id: string) => string
  /** The keystroke went in — and the sentence says what it did, not that it "approved". */
  sessApproved: (id: string) => string
  /** Refused: it is not asking anything at this moment, whatever the list said a poll ago. */
  sessNotAsking: string
  /** Refused: this harness's dialog has never been read, so there is no key to send. */
  sessApproveUnknown: (harness: string) => string
  /** Said on a row whose dialog offers OPTIONS and whose harness has no verified way to pick one. */
  sessChooseBlind: (harness: string) => string
  sessDialogBlind: (harness: string) => string
  /** Refused: the dialog offers N options, so there is nothing to merely "approve". */
  sessNeedsChoice: (n: number) => string
  /** Refused: the question changed between being shown and being answered. */
  sessChoiceGone: string
  /** Refused: no verified way to select an option by number on this harness. */
  sessChooseUnknown: (harness: string) => string
  /** The chosen option went in — and the sentence names WHICH, because that is the whole point. */
  sessAnswered: (label: string) => string
  /** The answer landed and the session immediately asked something ELSE. */
  sessAnsweredNewQuestion: (label: string) => string
  /** The keystroke was delivered and the dialog did not react to it. */
  sessAnswerStuck: (label: string) => string
  /** The write-your-own row was picked and no text field opened for it. */
  sessAnswerNoField: (label: string) => string
  /** Nothing fell, or everything that did has already been picked back up. */
  sessNoFell: string
  /** The session backend (tmux) could not be listed, so nothing can be judged fallen or alive. */
  sessBackendUnreadable: string
  sessFellOpened: (opened: number, skipped: number, held: number) => string
  sessFellNoneOpened: (skipped: number) => string
  /** Every row that was ticked has since left the group — the list the caller acted on has moved. */
  sessFellGone: (count: number) => string
  /** Nothing was ticked. Never read as "all" — see `selectFell`. */
  sessFellNonePicked: string
  /** A broadcast that was refused before anything was typed. */
  sessBroadcastRefused: (reason: string, skipped: number) => string
  /** What a broadcast did, per outcome. Partial delivery is the NORMAL case. */
  sessBroadcastDone: (sent: number, failed: number, skipped: number, reopened: number) => string
  sessBroadcastReopenSlow: string
  /**
   * Refusing to open a conversation a live session already has, and NAMING that session.
   *
   * The name is the whole message. "Already open" leaves someone hunting for it; the twins this
   * prevents were only found by reading two screens side by side and noticing identical text.
   */
  sessResumeInUse: (holder: string) => string
  /**
   * A takeover that could not end the process holding the conversation.
   *
   * Said instead of spawning: leaving the user with the assistant they already had beats handing
   * them a second one in the same transcript, which is what this whole lock exists to prevent.
   */
  sessAdoptFailed: (holder: string) => string
  /**
   * A takeover the pure planner refused, said in words.
   *
   * Shared with the CLI's `explainTakeover`: the same three refusals, so the cockpit and the command
   * line cannot describe one situation two ways.
   */
  sessTakeoverRefused: (reason: TakeoverRefusal) => string
  /** EXT.OPEN: the one question before a write ends an external process and continues here. */
  sessContinueConfirm: (harness: string, pid: number | undefined) => string
  /** EXT.OPEN: why an external session stays read-only. */
  sessContinueRefused: (reason: 'no-conversation' | 'not-resumable', harness: string) => string
  /** EXT.OPEN: the one line saying it continued here. */
  sessContinuedHere: string
  /** The fallback title for a session the user never named. */
  sessUntitled: (harness: string, project: string) => string
  /**
   * A session the backend is running that the registry has no record of.
   *
   * It has no harness and no directory to be named by, so the generic fallback produced a bare `?`.
   * This says what it actually is — see `session-adopt.ts` for how a row gets into that state.
   */
  sessUnregistered: (handle: string) => string
  /** Said when a harness's modes have never been driven, so no key is known. */
  sessModeUnknown: (harness: string) => string
  /** Said after the cycle key lands. It names the ACT — only the next poll knows the new mode. */
  sessModeCycled: string
  /** The free-text option was picked with nothing written. Enter on an empty field DECLINES. */
  sessAnswerNeedsText: string
  sessKilled: (id: string) => string
  /** The turn was handed back. Deliberately distinct from `sessKilled` — the session is still up. */
  sessInterrupted: (id: string) => string
  /** Refused: Escape into an idle prompt closes whatever the harness has open, which is not "stop". */
  sessInterruptIdle: (id: string) => string
  sessRestoreNone: string
  sessRestoreDeclined: (n: number) => string
  sessRestored: (opened: number, skipped: number) => string
  sessRestoreFailed: (skipped: number) => string
  sessNoTask: string
  sessTaskFinished: (task: string) => string
  /** The task named nothing — no session wears it and it is not in the finished list. */
  sessTaskUnknown: (task: string) => string
  /** Removed. Says how many sessions were UNFILED, because they were kept, not deleted. */
  sessTaskDeleted: (task: string, freed: number) => string
  sessTaskReopened: (task: string) => string
  sessKillUnconfirmed: (id: string) => string
  sessRenamed: string
  /**
   * A rename that landed in BOTH places — agentop's label and the harness's own name.
   *
   * Separate from `sessRenamed` because the two claims differ, and the difference is the feature:
   * one says a row was relabelled, the other says the session now calls itself that too.
   */
  sessRenamedBoth: string
  /**
   * The agentop label was written and the harness was NOT told — with the reason, in words.
   *
   * The label is never withheld over this: a rename that refuses outright would make a `lost` row
   * unnameable, and naming those rows is most of what the verb is for. But a rename that only half
   * happened and says nothing is indistinguishable from one that failed, which is the complaint this
   * whole feature answers in reverse.
   */
  sessRenamedLocalOnly: (why: string) => string
  /** A fact about the TOOL, not about this session: it publishes no rename channel at all. */
  sessRenameWhyUnsupported: (harness: string) => string
  sessRenameWhyExternal: string
  sessRenameWhyNotRunning: string
  sessRenameWhyDialog: string
  sessRenameWhyUntypable: string
  sessRenameWhyFailed: string
  /** Printed on the way into an attach, with the REAL detach key. */
  sessAttaching: (title: string, detach: string) => string
  sessNoted: string
  sessTasked: string
  /** SS-09: filed under a board task — and what that changes. */
  sessFiled: (task: string) => string
  /** SS-09: an external session with no known conversation has nothing the board can hold. */
  sessFileNoConversation: string
  /** SS-09: the board refused the filing — its reason, in words. */
  sessFileRefused: (reason: string) => string
  sessTaskEmpty: (task: string) => string
  sessTaskOpened: (task: string, opened: number, skipped: number, held: number) => string
  sessTaskNoneOpened: (task: string, skipped: number) => string
  /** A session the backend hosts but the registry never recorded has no metadata to patch. */
  sessNoRegistryEntry: string
  sessStarted: (name: string) => string
  sessStartedBg: (name: string) => string
  sessSpawnFailed: (reason: string) => string
  sessRewound: string
  sessRewindFailed: (reason: 'no-menu' | 'not-found' | 'unexpected' | 'failed') => string
  sessRewindUnsupported: (harness: string) => string
  sessSentNow: string
  /** What "send now" really did — one sentence per `SendNowOutcome`. */
  sessSendNowOutcome: (outcome: SendNowOutcome, id: string) => string
  sessSendNowUnsupported: (harness: string) => string
  /** A session whose pane died at birth, in the harness's own words or its exit status. */
  sessDiedAtSpawn: (reason: string) => string
  sessDiedAtSpawnStatus: (status: number | undefined) => string
  /** The harness binary could not be executed — almost always the server's PATH. */
  sessNotOnPath: (bin: string, path: string) => string
  /** No harness CLI at all on the server's PATH — a broken PATH, not "unknown". */
  sessNoHarnessOnPath: (path: string) => string
  sessSpawnUnsupported: (harness: string) => string
  sessSpawnNoResume: (harness: string) => string
  sessSpawnNoModel: (harness: string) => string
  sessSpawnNoEffort: (harness: string) => string
  sessSpawnBadEffort: (harness: string, value: string, accepted: string[]) => string

  /**
   * What `agentop session ls` says AROUND the table. The table's own chrome — its column headings
   * and its group labels — comes from the control center's strings, because it is the same table.
   */
  sessLs: {
    /** The fleet really is empty. Only ever printed when the poll actually succeeded. */
    none: string
    /**
     * Nothing is RUNNING, and the rows the filter withheld are still there.
     *
     * It names the flag that lifts it, for the same reason the cockpit's empty list does: a mute
     * blank is indistinguishable from a broken command, and the sessions a reboot turned into
     * `lost` rows are still named, still filed and still reopenable.
     */
    noneRunning: (hidden: number) => string
    waiting: (n: number, names: string) => string
    /** Harnesses whose approval prompts cannot be told from an ordinary pause. */
    blind: (harnesses: string) => string
  }

  dockerMissing: string
  dockerUnreachable: string
  foregroundLater: string
  useRestartInstead: string

  /**
   * The start options a service offers while it is down — the host composes them because only it
   * knows what this box can run, and a running service offers NONE of them.
   */
  optForeground: string
  optForegroundHint: string
  optBackground: string
  optBackgroundHint: string
  /** `machine` runtime, attached — `docker compose up --build` with no `-d`, Ctrl-C stops it. */
  optDockerForeground: string
  optDockerForegroundHint: string
  /** `machine` runtime, detached — the same, in the background. */
  optDockerBackground: string
  optDockerBackgroundHint: string
  optCentral: string
  optCentralHint: string
  /** One verb per SHAPE of central. They are separate deployments of one program, so they get
   *  separate labels — "Start" alone left the user to infer which one this box would pick. */
  optCentralImage: string
  optCentralImageHint: string
  optCentralBuild: string
  optCentralBuildHint: string
  /** Why a shape is NOT offered. The verb stays absent; the reason is said in the detail pane. */
  centralBlockedImageNoDocker: string
  centralBlockedBuildNoDocker: string
  centralBlockedBuildNoCheckout: string
  centralBlockedNativeBundled: string
  centralBlockedNativeNoEnv: string
  /** A native central (external Mongo, standalone path) — foreground, Ctrl-C to stop. */
  optCentralNativeForeground: string
  optCentralNativeForegroundHint: string
  /** Same, detached — returns immediately, runs in the background. */
  optCentralNativeBackground: string
  optCentralNativeBackgroundHint: string
  /** `Stop (native)` / `Stop (docker)` — offered only to break a conflict. */
  stopRuntime: (runtime: string) => string

  /**
   * The BOOT switch, both positions, composed here for the same reason the starts are: which unit
   * brings a service back is a fact about this box, and `agentistics` has two of them.
   *
   * `mech` is the mechanism in one word — the runtime for `agentistics`, nothing for the central,
   * which has only one. The confirmations NAME the unit, because a sentence that says "it will not
   * come back" and does not say what was doing the bringing back leaves the user with nothing to go
   * look at — which is the whole of the complaint these strings answer.
   */
  optBootOn: (mech: string) => string
  optBootOnHint: string
  optBootOff: (mech: string) => string
  optBootOffHint: string
  bootConfirmOn: (unit: string) => string
  bootConfirmOff: (unit: string) => string
  /** Asked right after a stop that worked, while a boot unit is still registered for it. */
  bootAfterStop: (service: string, unit: string) => string
  bootDisabled: (unit: string) => string
  bootDisableFailed: (unit: string) => string

  /**
   * Why a setup mode cannot be chosen right now.
   *
   * `central` re-runs `central.sh init`, which rewrites the environment file and recreates the
   * containers — on a central that is up that is a teardown of the thing being used. The sentence
   * names what to do instead, because a greyed row that explains nothing is indistinguishable from
   * a broken one.
   */
  setupBlockedCentralUp: string

  /**
   * The restarts a RUNNING service offers — composed here for the same reason the starts are: only
   * this side knows whether a rebuild has what it needs on this box.
   *
   * The rebuild is a second verb rather than a flag on the first because the two do different
   * amounts of work and the difference is the whole point of offering it: a bounce serves the build
   * that is already there, a rebuild makes a new one first.
   */
  optRestart: string
  optRestartHint: string
  optRebuild: string
  /** `Rebuild & restart (native)` — the conflict case, where each copy is rebuilt on its own. */
  optRebuildRuntime: (runtime: string) => string
  /** What a rebuild MEANS, per runtime: recompile the binary, or rebuild the image. */
  optRebuildNativeHint: string
  optRebuildDockerHint: string
  archiveUnsetHint: string
  dockerStartFailed: string
  /** A local (native) restart/rebuild whose health check never came back — the old process is
   *  gone but the new one never bound the port (crash on boot, port already taken, …). */
  localStartFailed: string
  /** The restart verbs. Each is the ONE sentence a person reads, so each names the cause and what to
   *  run — a restart is only claimed once the pid serving CHANGED (see `awaitReplacement`). */
  restartManagerUnreachable: (unit: string, detail: string) => string
  restartNotManaged: (subject: string, pid: number, unit: string, unitState: string) => string
  restartUnchanged: (unit: string, subject: string, pid: number) => string
  restartSilent: (unit: string, subject: string) => string
  restartRestarted: (unit: string, before: number, after: number) => string
  restartStarted: (unit: string, pid: number) => string
  restartNotStopped: (pid: number) => string
  centralStarted: string
  centralFailed: string
  centralInitDone: string
  centralInitFailed: string
  connected: string
  connectFailed: string
  /** The one-line outcome of a disconnect that left the machine with no central at all. */
  disconnected: string
  disconnectFailed: string
  stoppedAll: string
  stoppedDone: string
  soloSet: string
  archiveSet: (mode: string) => string
  prefsWriteFailed: string
  upgradeDone: string
  upgradeFailed: (code: number) => string

  // critical (unattended) update — printed by `agentop check-update`
  updateCriticalTitle: string
  updateCriticalInstalling: (version: string) => string
  updateCriticalLog: (path: string) => string
  updateCriticalRunning: string
  updateCriticalManualTitle: string
  updateCriticalManualHow: (cmd: string) => string
  updateCriticalUnsupported: (target: string) => string
  updateCriticalRetryLater: string

  // `agentop upgrade` — install safety (verification, rollback, restart failures)
  upgradeVerifying: string
  upgradeFromSource: (execPath: string) => string
  upgradeInProgress: (pid: number) => string
  upgradeLockUnavailable: string
  upgradeUnsupported: (target: string) => string
  upgradeManualHow: (url: string) => string
  upgradeVerifyFailed: (reason: string) => string
  upgradeRolledBack: (backup: string) => string
  upgradeUntouched: string
  upgradeBackupKept: (backup: string) => string
  upgradeRestartFailed: (version: string) => string
  upgradeRestartHint: string
  /** The restart command reported success, but the server answering requests never confirmed it. */
  upgradeVersionUnconfirmed: (version: string) => string

  // multi-central member commands (Task 6 — spec §8.2)
  cancel: string
  leaveWhich: string
  leaveAll: string
  leftOne: (endpoint: string) => string
  leftAll: (n: number) => string
  stillConnected: (n: number) => string
  noConnections: string
  ambiguousLeave: (n: number) => string
  connectedAs: (user: string, n: number) => string
  updatedExisting: (endpoint: string) => string
  tokenInUse: (endpoint: string) => string
  noMatchEndpoint: (endpoint: string) => string
  localServerUnknown: string
  stateAuthRejected: string
  stateNetUnreachable: string
  stateOk: string
  neverSynced: string

  // `agentop backup` / `agentop restore` — see backup/daemon.ts and cli-backup.ts
  backupScheduleOff: string
  backupScheduleNoServer: string
  backupSecretsOmitted: string
  backupNoneOnDisk: string
  /** The cockpit's `s` key and the CLI's `schedule` subcommand share this outcome sentence. */
  backupScheduleSet: (schedule: string) => string
  /** The cockpit's layers editor and `agentop backup config --layers` share this outcome sentence. */
  backupLayersSet: (layers: string) => string
  /** Same, for the schedule's own layers (`--schedule-layers`). */
  backupScheduleLayersSet: (layers: string) => string
  /** The cockpit's `b` key — same shape as the CLI's own report, in one sentence. */
  backupRunOk: (archiveBytesLabel: string) => string

  // `agentop provider try` — the rate-limit line (B9.3). Numbers arrive already formatted.
  rateLimitLabel: string
  rateLimitKind: Record<RateLimitResourceKind, string>
  rateLimitLeft: (remaining: string, limit?: string) => string
  /** A limit with no remaining stated — said, never rendered as `0 left`. */
  rateLimitLimitOnly: (limit: string) => string
  rateLimitUntil: (time: string) => string
  rateLimitRetryAfter: (seconds: string) => string
  rateLimitDropped: (n: number) => string
  rateLimitAbsent: (reason: RateLimitAbsentReason, dropped: number) => string

  // The engine (`engine/load.ts`). A verb this build lacks is a different sentence from a verb that
  // does not exist, and each reason an engine is absent is its own sentence.
  engineVerbAbsent: (verb: EngineVerb, reason: EngineAbsentReason) => string
  /** The engine is loaded and simply offers no such command. */
  engineVerbNotProvided: (verb: EngineVerb) => string
  /** The `agentop --version` line. */
  engineVersionLine: (status: EngineStatus) => string
}

const EN: CliStrings = {
  lang: 'en',
  tagline: 'AI coding-assistant analytics · agentop',
  configSolo: 'solo — nothing leaves this machine',
  configMemberBare: 'member — sends metrics to a central',
  configMember: (e) => `member — sends metrics to a central at ${e}`,
  configMembers: (n) => `member — sends metrics to ${n} centrals`,
  configMemberLine: (endpoint, suffix) => `  ↳ ${endpoint}${suffix}`,
  deniedSuffix: (n) => ` · ${n} repo(s) blocked`,
  configCentral: 'central — this machine hosts the team central',
  nothingRunning: 'nothing running',

  confirmKill: 'Kill it and start fresh?',
  alreadyRunning: (url) => `A server is already running on ${url}.`,
  leftRunning: 'left the running server as-is.',
  pauseMsg: 'Press Enter to go back',

  startedBg: 'started in the background.',
  logsLabel: 'logs',
  webLabel: 'web',
  bootLabel: 'boot',
  bootNote: 'it already restarts with Docker (restart: unless-stopped)',
  containerUp: 'machine container is up.',
  stoppingLocal: 'stopping the local server…',
  stopNoTarget: 'no server of this data dir could be named (no port listener visible, no server.lock holder) — nothing was signalled. Stop it by its pid if one is still running.',
  stoppingCentral: 'stopping the central container…',
  stoppingMachine: 'stopping the machine container…',
  restartingLocal: 'restarting the local server…',
  restartingCentral: 'restarting the central container…',
  restartingMachine: 'restarting the machine container…',
  rebuildingCentral: 'rebuilding the central image and recreating…',
  rebuildingMachine: 'rebuilding the machine image and recreating…',
  rebuildingLocal: 'rebuilding the native server (bun run bin)…',
  localRebuildHint: '--rebuild needs the repo to rebuild the native server. Run this from the agentistics checkout, or `agentop upgrade`. Restarting the existing build.',
  localRebuildFailed: 'native rebuild failed — restarting the existing build.',
  flagConflict: (a, b) => `${a} and ${b} contradict each other — pass one.`,
  rebuildNoCache: 'building from scratch (no Docker cache) — this takes several minutes. Pass --cache to reuse it.',
  restartedAll: 'restarted all running services.',
  restartedDone: 'service restarted.',
  restartFailed: "that didn't come back up — see the output above for why.",
  noComposeFrom: (dir) => `couldn't find docker/machine.yml in ${dir}.`,
  runFromRepo: 'Run agentop start from the agentistics repo to use Docker.',
  buildingMachine: 'building & starting the machine container…',

  urlOpened: url => `opened ${url}`,
  urlOpenFailed: 'could not open a browser from here',

  svcAgentistics: 'agentistics',
  svcCentral: 'agentistics central',
  svcConflict: (runtimes) => `conflict: ${runtimes.join(' + ')} both running — stop one`,
  svcIdleServer: pids => pids.length === 1
    ? `a second server (pid ${pids[0]}) is running and serving nothing — "Stop extra copies" removes it`
    : `${pids.length} extra servers (pids ${pids.join(', ')}) are running and serving nothing — "Stop extra copies" removes them`,
  actStopIdle: 'Stop extra copies',
  idleStopped: n => n === 1 ? 'stopped the extra server.' : `stopped ${n} extra servers.`,
  idleNoneLeft: 'no extra servers are running any more.',
  svcNotRunning: 'that service is not running.',

  sessState: {
    working: 'working',
    waitingApproval: 'approve',
    // Named for what it means to the READER. `waiting` and `working` differ by two letters in the
    // middle of a narrow column, so the state that needs a person was being read as the one that
    // does not — and `needs you` sits beside `needs approval` as the pair they are.
    waiting: 'needs you',
    // ONE word for every way a session is not running. `exited`, `lost` and `closed` are three
    // internal facts and were three words on the row — but a reader has one question here ("is it
    // running?") and one move available ("reopen it"), so three answers to it was noise dressed as
    // precision. The distinction still exists in the state and is still said by the DETAIL pane;
    // the column stops spending three vocabularies on one bit.
    exited: 'ended',
    lost: 'ended',
    closed: 'ended',
    external: 'external',
  },
  sessBackground: 'subagent',
  sessApprovalBlind: (harness: string) =>
    `agentop has no verified screen markers for ${harness}, so a blocking question here shows as "needs you" like any other pause.`,
  sessDirGone: 'this directory no longer exists — a removed worktree, most likely. Reopening will not work until it is back.',
  sessConversationBlind: (harness: string) =>
    `${harness} never reports which conversation a session it started is writing, so agentop cannot record the link — anything offered to reopen here is inferred from the directory.`,
  sessConversationLost: (harness: string) =>
    `this session ended before agentop could capture which conversation it was — ${harness} only names it in its own log while the process is alive, and that process is gone. It cannot be reopened.`,
  sessApproveBlind: (harness: string) =>
    `nobody has read ${harness}'s dialog, so agentop does not know which key answers it — attach to this session to answer it there.`,
  sessPrompted: (id: string) => `sent to ${id}.`,
  sessPromptBlocked:
    'that session has a question open, so typed text would be answering its menu. Approve it, or attach and answer it there.',
  sessNotRunning: 'nothing is running in that session to type into.',
  sessPromptEmpty: 'nothing to send.',
  sessSendFailed: (id: string) => `${id} did not take the keystroke — it may have just ended.`,
  sessApproved: (id: string) => `sent the confirm key to ${id}.`,
  sessNotAsking: 'that session is not asking anything right now — nothing was sent.',
  sessApproveUnknown: (harness: string) =>
    `agentop has not read ${harness}'s dialog, so it will not guess which key answers it.`,
  sessChooseBlind: (harness: string) =>
    `this dialog is a choice, and nobody has verified how to pick an option on ${harness} — attach to answer it there.`,
  // Deliberately NOT "cannot be answered": it can, on attach. And it says what agentop actually
  // knows — that the options are there and it could not read them — because a refusal that hides
  // its reason is indistinguishable from a control that is simply broken.
  sessDialogBlind: (harness: string) =>
    `this ${harness} dialog is taller than agentop can read off the screen, so it cannot say what the options are — attach to answer it there.`,
  sessNeedsChoice: (n: number) =>
    `that dialog offers ${n} options, so there is nothing to simply approve — pick one.`,
  sessChoiceGone:
    'the session is asking something else now — nothing was sent. Look again before answering.',
  sessChooseUnknown: (harness: string) =>
    `agentop has no verified way to pick an option on ${harness}, and will not confirm the highlighted one for you — attach to answer it there.`,
  sessAnswered: (label: string) => `answered: ${label}`,
  sessAnsweredNewQuestion: (label: string) =>
    `answered: ${label} — and the session is already asking something else, which is why a question `
    + 'is still on screen. Nothing was pressed into the new one.',
  sessAnswerStuck: (label: string) =>
    `the key for "${label}" was delivered and the dialog did not move. Nothing else was pressed — `
    + 'answer it in the session itself (attach), because pressing again could act on a row you did '
    + 'not choose.',
  sessAnswerNoField: (label: string) =>
    `"${label}" did not open a field to type into, so nothing was typed — the words would have gone `
    + 'wherever the session was listening and the return would have submitted whatever was '
    + 'highlighted. Answer it in the session itself (attach).',
  sessNoFell: 'nothing fell — no session was lost with the machine still on record.',
  sessBackendUnreadable: 'could not list the running sessions (tmux did not answer), so nothing was reopened — a session that is still running would have been started twice. Try again in a moment.',
  sessFellOpened: (opened: number, skipped: number, held: number) =>
    `reopened ${opened} session(s) that fell.`
    + (held > 0 ? ` ${held} already open in another session.` : '')
    + (skipped > 0 ? ` ${skipped} could not be reopened.` : ''),
  sessFellNoneOpened: (skipped: number) =>
    `none of the ${skipped} session(s) that fell could be reopened.`,
  sessFellGone: (count: number) =>
    `${count} session(s) picked are no longer in that group — they ended, or another window reopened `
    + 'them already. Nothing was opened.',
  sessFellNonePicked: 'no session was picked, so nothing was reopened.',
  sessBroadcastRefused: (reason: string, skipped: number) => {
    if (reason === 'no-text') return 'nothing was typed, so nothing was sent.'
    if (reason === 'no-selection') return 'no session was picked. This never means all of them.'
    if (reason === 'too-many') {
      return 'that is more sessions than one message may reach at once — pick fewer, or send twice.'
    }
    return `none of the ${skipped} session(s) picked can take a prompt right now — see the reason on each.`
  },
  sessBroadcastDone: (sent: number, failed: number, skipped: number, reopened: number) => {
    const parts = [`sent to ${sent} session${sent === 1 ? '' : 's'}`]
    // Said because it STARTED something: a reopen spawns an assistant, which is a bigger act than
    // typing into one that was already running, and the person should read that it happened.
    if (reopened > 0) parts.push(`${reopened} reopened first`)
    // Named separately: a REFUSAL at write time (the session was asking after all) and a row that
    // was never eligible are two different things to do something about.
    if (failed > 0) parts.push(`${failed} refused it`)
    if (skipped > 0) parts.push(`${skipped} could not be sent to`)
    return `${parts.join(', ')}.`
  },
  sessBroadcastReopenSlow:
    'it was reopened but had not come up in time to be written to — nothing was typed into it.',
  sessResumeInUse: (holder: string) =>
    `that conversation is already open in ${holder} — open it there instead of starting a second assistant in it.`,
  sessAdoptFailed: (holder: string) =>
    `the assistant running that conversation (${holder}) would not stop, so it was left alone — nothing was opened.`,
  sessTakeoverRefused: (reason: TakeoverRefusal) => {
    switch (reason.code) {
      case 'resume-unsupported':
        return `${reason.harness} cannot reopen a conversation by id, so the assistant holding it was left alone.`
      case 'holder-unreachable':
        return `something is holding this conversation${reason.label ? ` (${reason.label})` : ''} and agentop cannot close it.`
      case 'no-cwd':
        return 'this conversation has no directory to reopen in — a removed worktree, most likely.'
    }
  },
  sessContinueConfirm: (harness, pid) =>
    `this ${harness} session is still open in another terminal${pid !== undefined ? ` (pid ${pid})` : ''}. Sending ends that process and continues the same conversation here — a turn it is in the middle of is cut.`,
  sessContinueRefused: (reason, harness) => reason === 'no-conversation'
    ? `this ${harness} process never said which conversation it is writing, so it is shown live and read-only — continuing a guessed conversation here could write into the wrong one.`
    : `${harness} cannot reopen a conversation by id, so this session is shown live and read-only — write to it in its own terminal.`,
  sessContinuedHere: 'continued here — the conversation is now an agentop session.',
  sessUntitled: (harness: string, project: string) => (project ? `${harness} in ${project}` : harness),
  sessUnregistered: (handle: string) => `unregistered session ${handle}`,
  sessModeUnknown: (harness: string) =>
    `nobody has driven ${harness}'s modes, so agentop does not know which key changes them — switch it inside the session.`,
  sessModeCycled: 'moved to the next mode.',
  sessAnswerNeedsText: 'this option is a field to write in — send it with your answer, because an empty one reads as declining the question.',
  sessKilled: (id: string) => `stopped ${id}.`,
  sessInterrupted: (id: string) => `asked ${id} to stop what it was doing — the session is still up.`,
  sessInterruptIdle: (id: string) => `${id} is not working right now, so there is nothing to stop.`,
  sessRestoreNone: 'those sessions are no longer in the registry.',
  sessRestoreDeclined: (n: number) =>
    `left ${n} session${n === 1 ? '' : 's'} closed — still listed, still reopenable.`,
  sessRestored: (opened: number, skipped: number) =>
    `restored ${opened}${skipped ? `, ${skipped} could not be` : ''}.`,
  sessRestoreFailed: (skipped: number) =>
    `nothing could be restored${skipped ? ` — ${skipped} had no conversation to reopen` : ''}.`,
  sessNoTask: 'that session has no task.',
  sessTaskFinished: (task: string) => `"${task}" marked finished.`,
  sessTaskUnknown: (task: string) => `no session is filed under "${task}", and it is not a finished task.`,
  sessTaskDeleted: (task: string, freed: number) => freed === 0
    ? `"${task}" removed.`
    : `"${task}" removed — ${freed} session(s) kept, now unfiled.`,
  sessTaskReopened: (task: string) => `"${task}" reopened.`,
  sessKillUnconfirmed: (id: string) =>
    `could not confirm ${id} was stopped — it may still be running, so its record was kept.`,
  sessRenamed: 'session renamed.',
  sessRenamedBoth: 'renamed here and inside the session.',
  sessRenamedLocalOnly: (why: string) => `renamed in agentop only — ${why}`,
  sessRenameWhyUnsupported: (harness: string) =>
    `${harness} publishes no way to rename a session from outside, so it keeps its own name.`,
  sessRenameWhyExternal:
    'agentop did not start this session, so there is no pane to type into — it keeps its own name.',
  sessRenameWhyNotRunning:
    'nothing is running, so the harness could not be told — it will keep the name it had.',
  sessRenameWhyDialog:
    'that session has a question open, and typing now would answer it. Answer it, then rename again to carry the name across.',
  sessRenameWhyUntypable: 'the name has a line break, which cannot be typed as a single command.',
  sessRenameWhyFailed: 'the session did not take the keystroke — it may have just ended.',
  sessAttaching: (title: string, detach: string) =>
    `Attaching to ${title}. To leave it running and come back here, press ${detach}.`,
  sessNoted: 'note saved.',
  sessTasked: 'task set.',
  sessFiled: (task: string) => `filed under ${task} — its cost rolls up there from now on.`,
  sessFileNoConversation: 'agentop cannot see which conversation this external session is, so there is nothing to file — start it from agentop, or file it from the web once its conversation is known.',
  sessFileRefused: (reason: string) => `the board did not file it: ${reason}.`,
  sessTaskEmpty: (task: string) => `no sessions are filed under "${task}".`,
  sessTaskOpened: (task: string, opened: number, skipped: number, held: number) =>
    `reopened ${opened} session(s) of "${task}".`
    + (held > 0 ? ` ${held} already open in another session.` : '')
    + (skipped > 0 ? ` ${skipped} could not be reopened.` : ''),
  sessTaskNoneOpened: (task: string, skipped: number) =>
    `none of the ${skipped} session(s) of "${task}" could be reopened.`,
  sessNoRegistryEntry: 'that session has no record to update — it was not started by agentop.',
  sessStarted: (name: string) => `started ${name}.`,
  sessStartedBg: (name: string) => `started ${name} in the background.`,
  sessSpawnFailed: (reason: string) => `could not start the session: ${reason}`,
  sessRewound: 'Conversation restored to that point. Your next message continues from there.',
  sessRewindFailed: reason => reason === 'no-menu'
    ? 'The session did not open its rewind menu — nothing was changed.'
    : reason === 'not-found'
      ? 'That message is not in the session\'s rewind list — nothing was changed.'
      : reason === 'unexpected'
        ? 'The session asked something agentop does not know how to answer, so the rewind was cancelled — nothing was changed. Use the terminal for this one.'
        : 'Could not reach the session to rewind it — nothing was changed.',
  sessRewindUnsupported: harness => `Restoring the conversation is only available for Claude Code sessions (this one is ${harness}).`,
  sessSentNow: 'Queued messages sent now.',
  sessSendNowOutcome: (outcome, id) => ({
    sent: 'Delivered now — the session took the queued message without stopping its turn.',
    interrupted: 'Delivered — the session would not yield, so its current turn was interrupted to hand the message over.',
    nothing: 'Nothing was waiting in the session’s queue — the message had already been taken in.',
    stuck: 'Not delivered — the session kept the message queued even after being interrupted. Open the terminal to see why.',
    'no-focus': 'Not delivered — the session’s input box could not be reached, so nothing was pressed.',
    failed: `${id} did not take the keystroke — it may have just ended.`,
  } satisfies Record<SendNowOutcome, string>)[outcome],
  sessSendNowUnsupported: harness => `"Send now" is only available for Claude Code sessions (this one is ${harness}).`,
  sessDiedAtSpawn: (reason: string) => `the session exited as soon as it started: ${reason}`,
  sessDiedAtSpawnStatus: (status: number | undefined) =>
    `the session exited as soon as it started${status !== undefined ? ` (status ${status})` : ''}`,
  sessNotOnPath: (bin: string, path: string) =>
    `\`${bin}\` could not be executed — is it on the agentop server's PATH? The server sees: ${path || '(empty)'}. ` +
    'If agentop runs as a service, run `agentop restart server` from a terminal that can run it.',
  sessNoHarnessOnPath: (path: string) =>
    `The agentop server cannot see any coding assistant on its PATH (${path || 'empty'}). ` +
    'If it runs as a service, run `agentop restart server` from a terminal where the assistants work.',
  sessSpawnUnsupported: (harness: string) => `agentop cannot start ${harness} yet.`,
  sessSpawnNoResume: (harness: string) => `${harness} cannot reopen a conversation by id.`,
  sessSpawnNoModel: (harness: string) => `${harness} has no model flag, so a model cannot be set.`,
  sessSpawnNoEffort: (harness: string) => `${harness} has no effort flag, so an effort cannot be set.`,
  sessSpawnBadEffort: (harness: string, value: string, accepted: string[]) =>
    `${harness} does not accept effort "${value}". Accepted: ${accepted.join(', ')}.`,

  sessLs: {
    none: 'No sessions.',
    noneRunning: (hidden: number) =>
      `Nothing is running — ${hidden} session${hidden === 1 ? '' : 's'} withheld. Run \`agentop session ls --all\` to list them.`,
    waiting: (n: number, names: string) =>
      `${n} session${n === 1 ? '' : 's'} waiting on you: ${names}`,
    blind: (harnesses: string) =>
      `Approval detection is not available for: ${harnesses} — those sessions show as "waiting" either way.`,
  },

  dockerMissing: 'docker not installed',
  dockerUnreachable: 'docker is installed but not answering',
  foregroundLater: 'foreground starts once this screen closes.',
  useRestartInstead: 'Use Restart to replace it.',

  optForeground: 'Start (this terminal)',
  optForegroundHint: 'runs here until you quit',
  optBackground: 'Start (background)',
  optBackgroundHint: 'detached — keeps running',
  optDockerForeground: 'Start (docker, this terminal)',
  optDockerForegroundHint: 'attached — Ctrl-C stops it',
  optDockerBackground: 'Start (docker, background)',
  optDockerBackgroundHint: 'detached — the same server, in a container',
  optCentral: 'Start',
  optCentralHint: 'the team central, in Docker',
  optCentralImage: 'Start (docker · published image)',
  optCentralImageHint: 'pulls ghcr.io/agentistics/agentistics — no build, no checkout needed',
  optCentralBuild: 'Start (docker · build from source)',
  optCentralBuildHint: 'builds the image from this checkout, then recreates the container',
  centralBlockedImageNoDocker: 'Published image: needs Docker, and `docker` is not on PATH here.',
  centralBlockedBuildNoDocker: 'Build from source: needs Docker, and `docker` is not on PATH here.',
  centralBlockedBuildNoCheckout: 'Build from source: needs an agentistics checkout — this is the installed binary. The published image runs the same central.',
  centralBlockedNativeBundled: 'Native: needs an external database. This central uses the bundled Mongo, which only Docker starts — re-run setup and choose an external URI to switch.',
  centralBlockedNativeNoEnv: 'Native: this central is not configured yet, so its database is unknown.',
  optCentralNativeForeground: 'Start (this terminal)',
  optCentralNativeForegroundHint: 'runs here until you quit — no Docker needed',
  optCentralNativeBackground: 'Start (background)',
  optCentralNativeBackgroundHint: 'detached — keeps running, no Docker needed',
  stopRuntime: (runtime) => `Stop (${runtime})`,
  optBootOn: (mech) => (mech ? `Start at boot (${mech})` : 'Start at boot'),
  optBootOnHint: 'register a systemd user service so it comes back after a reboot',
  optBootOff: (mech) => (mech ? `Do not start at boot (${mech})` : 'Do not start at boot'),
  optBootOffHint: 'remove that registration — anything running now keeps running',
  bootConfirmOn: (unit) => `Register ${unit} so this comes back on every boot?`,
  bootConfirmOff: (unit) =>
    `Remove ${unit}? It stops bringing this back after a reboot. Anything running now keeps running.`,
  bootAfterStop: (service, unit) =>
    `${service} is stopped, but ${unit} still starts it at boot. Remove that registration too?`,
  bootDisabled: (unit) => `${unit} removed — it no longer starts at boot.`,
  bootDisableFailed: (unit) => `Could not remove ${unit}.`,
  setupBlockedCentralUp: 'the central is running — stop it before reconfiguring it',
  optRestart: 'Restart',
  optRestartHint: 'bounce it — same build',
  optRebuild: 'Rebuild & restart',
  optRebuildRuntime: (runtime) => `Rebuild & restart (${runtime})`,
  optRebuildNativeHint: 'recompile the binary first (bun run bin), then restart',
  optRebuildDockerHint: 'rebuild the image and recreate the container',
  archiveUnsetHint: 'history preservation is still unset — the config pane can set it',
  dockerStartFailed: 'the machine container did not start.',
  localStartFailed: 'the local server did not come back up.',
  restartManagerUnreachable: (unit, detail) =>
    `Could not restart ${unit}: systemctl --user cannot reach the service manager (${detail}). Nothing was changed. ` +
    'Start a user session (or run `loginctl enable-linger $USER`), or stop the server and start it again with `agentop server`.',
  restartNotManaged: (subject, pid, unit, unitState) =>
    `${cap(subject)} (pid ${pid}) is not managed by systemd here — ${unit} is ${unitState} — so restarting the unit would leave it serving the old code. Nothing was changed. ` +
    `Stop it (\`kill ${pid}\`) and run \`agentop restart server\` again, or start it again with \`agentop server\`.`,
  restartUnchanged: (unit, subject, pid) =>
    `systemctl reported ${unit} restarted, but ${subject} is still pid ${pid} — nothing was replaced, so the code and config are unchanged. ` +
    `Check \`systemctl --user status ${unit}\`.`,
  restartSilent: (unit, subject) =>
    `${unit} was restarted, but ${subject} did not come back within the check window — it may have failed to start. ` +
    `Recent logs: \`journalctl --user -u ${unit} -n 50\`.`,
  restartRestarted: (unit, before, after) =>
    `Restarted ${unit} — pid ${before} → ${after}, it now runs the current code and config.`,
  restartStarted: (unit, pid) => `Started ${unit} (pid ${pid}) — it was not running.`,
  restartNotStopped: (pid) =>
    `The old server (pid ${pid}) is still running — it did not stop, so nothing was restarted. ` +
    `Stop it yourself (\`kill ${pid}\`) and start it again with \`agentop server\`.`,
  centralStarted: 'agentistics central is up.',
  centralFailed: 'the central did not start.',
  centralInitDone: 'central configured.',
  centralInitFailed: 'central init did not complete.',
  connected: 'connected — this machine is now a member.',
  connectFailed: 'could not connect to the central.',
  disconnected: 'disconnected — this machine is back to solo.',
  disconnectFailed: 'could not disconnect from the central.',
  stoppedAll: 'stopped every running service.',
  stoppedDone: 'service stopped.',
  soloSet: 'solo mode set — nothing leaves this machine.',
  archiveSet: (mode) => `history preservation set to ${mode}.`,
  prefsWriteFailed: 'could not write preferences.',
  upgradeDone: 'upgraded, and everything that was running was restarted onto the new version.',
  upgradeFailed: (code) => `upgrade exited ${code} — see the output above.`,

  updateCriticalTitle: 'Critical update — installing automatically',
  updateCriticalInstalling: (v) => `v${v} is being installed in the background; your terminal is free.`,
  updateCriticalLog: (p) => `Progress: ${p}`,
  updateCriticalRunning: 'A critical update is already being installed in the background.',
  updateCriticalManualTitle: 'Critical update available',
  updateCriticalManualHow: (cmd) => `Install it with ${cmd} — automatic install is opt-in (AGENTISTICS_AUTO_UPGRADE=1).`,
  updateCriticalUnsupported: (target) => `Automatic install is not available for ${target} — install it by hand.`,
  updateCriticalRetryLater: 'A critical update failed to install earlier; it will be retried later.',

  upgradeVerifying: '  Verifying the downloaded binary…',
  upgradeFromSource: (execPath) => `Refusing to upgrade: this is a source checkout, so upgrading would overwrite ${execPath}. Build/install the binary instead (bun run build:binary).`,
  upgradeInProgress: (pid) => `An upgrade is already running (pid ${pid}) — nothing to do.`,
  upgradeLockUnavailable: 'Could not write the upgrade lock; continuing without it.',
  upgradeUnsupported: (target) => `No agentop release is published for ${target}, so it cannot upgrade itself.`,
  upgradeManualHow: (url) => `Download the right binary for your platform and replace it by hand: ${url}`,
  upgradeVerifyFailed: (reason) => `Upgrade aborted: ${reason}.`,
  upgradeRolledBack: (backup) => `The previous binary was restored from ${backup}.`,
  upgradeUntouched: 'The installed binary was left untouched.',
  upgradeBackupKept: (backup) => `Previous binary kept at ${backup}.`,
  upgradeRestartFailed: (version) => `v${version} is installed, but some services were NOT restarted onto it:`,
  upgradeRestartHint: 'Restart them by hand (e.g. `agentop restart --all`) — they still run the old version.',
  upgradeVersionUnconfirmed: (version) =>
    `v${version} is installed and the restart command succeeded, but nothing has confirmed it is actually running yet:`,

  cancel: 'Cancel',
  leaveWhich: 'Leave which central?',
  leaveAll: 'Leave all centrals',
  leftOne: (endpoint) => `left ${endpoint}`,
  leftAll: (n) => `left all ${n} central${n === 1 ? '' : 's'} — back to solo.`,
  stillConnected: (n) => `still connected to ${n} central(s).`,
  noConnections: 'not connected to any central.',
  ambiguousLeave: (n) => `connected to ${n} centrals — pass --endpoint <url> or --all.`,
  connectedAs: (user, n) => `connected as ${user} — ${n} central(s) total.`,
  updatedExisting: (endpoint) => `updated the existing connection to ${endpoint}`,
  tokenInUse: (endpoint) => `that token already belongs to ${endpoint}`,
  noMatchEndpoint: (endpoint) => `no connection matches endpoint ${endpoint}`,
  localServerUnknown: 'unknown (local server not running)',
  stateAuthRejected: 'token rejected by central',
  stateNetUnreachable: 'central unreachable',
  stateOk: 'ok',
  neverSynced: 'never',

  backupScheduleOff: 'schedule: off',
  backupScheduleNoServer: 'schedule: inactive — the server is not running, so nothing will fire',
  backupSecretsOmitted: 'These were NOT in the backup. Re-establish each:',
  backupNoneOnDisk: 'last backup: none (no recorded backup whose file is still on disk)',
  backupScheduleSet: schedule => `schedule: ${schedule}`,
  backupLayersSet: layers => `layers: ${layers}`,
  backupScheduleLayersSet: layers => `schedule layers: ${layers}`,
  backupRunOk: bytes => `backup written — ${bytes}`,
  rateLimitLabel: 'rate limit',
  rateLimitKind: {
    requests: 'requests',
    tokens: 'tokens',
    'input-tokens': 'input tokens',
    'output-tokens': 'output tokens',
    'project-tokens': 'project tokens',
  },
  rateLimitLeft: (remaining, limit) => `${limit === undefined ? remaining : `${remaining}/${limit}`} left`,
  rateLimitLimitOnly: limit => `limit ${limit} (remaining not stated)`,
  rateLimitUntil: time => `until ${time}`,
  rateLimitRetryAfter: seconds => `retry after ${seconds}s`,
  rateLimitDropped: n => `${n} header${n === 1 ? '' : 's'} unreadable`,
  rateLimitAbsent: (reason, dropped) => {
    switch (reason) {
      case 'not-documented': return 'not stated — this provider documents no rate-limit header'
      case 'unknown-format': return 'not read — no documented rate-limit header format for this provider'
      case 'no-headers': return 'not stated — the response carried no rate-limit header'
      case 'unparseable': return `not read — ${dropped} rate-limit header${dropped === 1 ? ' was' : 's were'} present and none could be parsed`
    }
  },
  engineVerbAbsent: (verb, reason) => {
    const what = ENGINE_VERB_WHAT.en[verb]
    switch (reason) {
      case 'community-build': return `\`agentop ${verb}\` ${what}, which is in the official build of agentop and not in this one. Download it from ${OFFICIAL_BUILD_URL}, or keep using the harnesses you already have — every metric works without it.`
      case 'disabled': return `\`agentop ${verb}\` ${what}. This binary carries the engine, but AGENTISTICS_ENGINE=0 switched it off — unset it to use this command.`
      case 'api-mismatch': return `\`agentop ${verb}\` ${what}, but this binary's engine was built for a different contract version and was not loaded — a release defect; upgrading agentop fixes it. Everything else keeps working.`
      case 'load-failed': return `\`agentop ${verb}\` ${what}, but this binary's engine failed to load (the reason is in the log). Everything else keeps working.`
    }
  },
  engineVerbNotProvided: verb => `\`agentop ${verb}\` ${ENGINE_VERB_WHAT.en[verb]}, and the engine in this build does not provide it yet.`,
  engineVersionLine: st => {
    if (st.present) return `engine ${st.manifest.version} (api ${st.manifest.apiVersion})`
    switch (st.reason) {
      case 'community-build': return 'engine: none — community build'
      case 'disabled': return 'engine: off — AGENTISTICS_ENGINE=0'
      case 'api-mismatch': return 'engine: not loaded — contract version mismatch'
      case 'load-failed': return 'engine: not loaded — it failed to load (see the log)'
    }
  },
}

const PT: CliStrings = {
  lang: 'pt',
  tagline: 'Analytics de assistentes de código IA · agentop',
  configSolo: 'solo — nada sai desta máquina',
  configMemberBare: 'member — envia métricas para uma central',
  configMember: (e) => `member — envia métricas para uma central em ${e}`,
  configMembers: (n) => `member — envia métricas para ${n} centrais`,
  configMemberLine: (endpoint, suffix) => `  ↳ ${endpoint}${suffix}`,
  deniedSuffix: (n) => ` · ${n} repo(s) bloqueado(s)`,
  configCentral: 'central — esta máquina hospeda a central do time',
  nothingRunning: 'nada rodando',

  confirmKill: 'Matar e subir de novo?',
  alreadyRunning: (url) => `Já tem um server rodando em ${url}.`,
  leftRunning: 'mantive o server que já estava rodando.',
  pauseMsg: 'Pressione Enter para voltar',

  startedBg: 'iniciado em background.',
  logsLabel: 'logs',
  webLabel: 'web',
  bootLabel: 'boot',
  bootNote: 'já reinicia com o Docker (restart: unless-stopped)',
  containerUp: 'container da máquina está no ar.',
  stoppingLocal: 'parando o server local…',
  stopNoTarget: 'nenhum server deste diretório de dados pôde ser identificado (nenhum processo visível na porta, ninguém com o server.lock) — nada foi sinalizado. Se ainda houver um rodando, pare-o pelo pid.',
  stoppingCentral: 'parando o container da central…',
  stoppingMachine: 'parando o container da máquina…',
  restartingLocal: 'reiniciando o server local…',
  restartingCentral: 'reiniciando o container da central…',
  restartingMachine: 'reiniciando o container da máquina…',
  rebuildingCentral: 'reconstruindo a imagem da central e recriando…',
  rebuildingMachine: 'reconstruindo a imagem da máquina e recriando…',
  rebuildingLocal: 'reconstruindo o server nativo (bun run bin)…',
  localRebuildHint: '--rebuild precisa do repo para reconstruir o server nativo. Rode de dentro do checkout do agentistics, ou use `agentop upgrade`. Reiniciando o build atual.',
  localRebuildFailed: 'falha ao reconstruir o server nativo — reiniciando o build atual.',
  flagConflict: (a, b) => `${a} e ${b} se contradizem — passe apenas um.`,
  rebuildNoCache: 'buildando do zero (sem cache do Docker) — leva vários minutos. Use --cache para reaproveitá-lo.',
  restartedAll: 'todos os serviços no ar foram reiniciados.',
  restartedDone: 'serviço reiniciado.',
  restartFailed: 'não voltou a rodar — veja a saída acima para saber o motivo.',
  noComposeFrom: (dir) => `não achei docker/machine.yml em ${dir}.`,
  runFromRepo: 'Rode agentop start de dentro do repo agentistics para usar Docker.',
  buildingMachine: 'buildando & subindo o container da máquina…',

  urlOpened: url => `abriu ${url}`,
  urlOpenFailed: 'não foi possível abrir um navegador daqui',

  svcAgentistics: 'agentistics',
  svcCentral: 'agentistics central',
  svcConflict: (runtimes) => `conflito: ${runtimes.join(' + ')} rodando juntos — pare um`,
  svcIdleServer: pids => pids.length === 1
    ? `um segundo servidor (pid ${pids[0]}) está rodando sem servir nada — "Parar cópias extras" o encerra`
    : `${pids.length} servidores extras (pids ${pids.join(', ')}) rodando sem servir nada — "Parar cópias extras" os encerra`,
  actStopIdle: 'Parar cópias extras',
  idleStopped: n => n === 1 ? 'o servidor extra foi encerrado.' : `${n} servidores extras foram encerrados.`,
  idleNoneLeft: 'não há mais servidores extras rodando.',
  svcNotRunning: 'esse serviço não está rodando.',

  sessState: {
    working: 'trabalhando',
    waitingApproval: 'aprovar',
    // Named for what it means to the READER rather than for what the machine is doing, and it
    // pairs with `precisa de aprovação` above as the distinction it is.
    waiting: 'precisa de você',
    // One word for every way it is not running, as in English (the detail pane says which).
    exited: 'encerrada',
    lost: 'encerrada',
    closed: 'encerrada',
    external: 'externa',
  },
  sessBackground: 'subagente',
  sessApprovalBlind: (harness: string) =>
    `o agentop não tem marcadores de tela verificados para ${harness}, então uma pergunta bloqueante aqui aparece como "precisa de você", como qualquer outra pausa.`,
  sessDirGone: 'este diretório não existe mais — provavelmente uma worktree removida. Reabrir não vai funcionar enquanto ele não voltar.',
  sessConversationBlind: (harness: string) =>
    `o ${harness} nunca informa qual conversa uma sessão iniciada por ele está escrevendo, então o agentop não consegue registrar o vínculo — o que for oferecido para reabrir aqui é inferido pelo diretório.`,
  sessConversationLost: (harness: string) =>
    `esta sessão terminou antes que o agentop conseguisse capturar qual conversa ela era — o ${harness} só informa isso no próprio log enquanto o processo está vivo, e esse processo já se foi. Não é possível reabri-la.`,
  sessApproveBlind: (harness: string) =>
    `ninguém leu o diálogo do ${harness}, então o agentop não sabe qual tecla responde — anexe na sessão para responder lá.`,
  sessPrompted: (id: string) => `enviado para ${id}.`,
  sessPromptBlocked:
    'essa sessão está com uma pergunta aberta, então o texto digitado responderia o menu dela. Aprove, ou anexe e responda lá.',
  sessNotRunning: 'não há nada rodando nessa sessão para digitar.',
  sessPromptEmpty: 'nada para enviar.',
  sessSendFailed: (id: string) => `${id} não aceitou a tecla — pode ter acabado de encerrar.`,
  sessApproved: (id: string) => `tecla de confirmação enviada para ${id}.`,
  sessNotAsking: 'essa sessão não está perguntando nada agora — nada foi enviado.',
  sessApproveUnknown: (harness: string) =>
    `o agentop não leu o diálogo do ${harness}, e não vai chutar qual tecla responde.`,
  sessChooseBlind: (harness: string) =>
    `esse diálogo é uma escolha, e ninguém verificou como selecionar uma opção no ${harness} — anexe para responder lá.`,
  sessDialogBlind: (harness: string) =>
    `esse diálogo do ${harness} é mais alto do que o agentop consegue ler da tela, então ele não sabe dizer quais são as opções — anexe para responder lá.`,
  sessNeedsChoice: (n: number) =>
    `esse diálogo tem ${n} opções, então não há o que simplesmente aprovar — escolha uma.`,
  sessChoiceGone:
    'a sessão está perguntando outra coisa agora — nada foi enviado. Olhe de novo antes de responder.',
  sessChooseUnknown: (harness: string) =>
    `o agentop não tem forma verificada de escolher uma opção no ${harness}, e não vai confirmar a destacada por você — anexe para responder lá.`,
  sessAnswered: (label: string) => `respondido: ${label}`,
  sessAnsweredNewQuestion: (label: string) =>
    `respondido: ${label} — e a sessão já está perguntando outra coisa, que é por isso que ainda há `
    + 'uma pergunta na tela. Nada foi enviado para a nova.',
  sessAnswerStuck: (label: string) =>
    `a tecla de "${label}" foi entregue e o diálogo não se moveu. Nada mais foi enviado — responda `
    + 'na própria sessão (attach), porque apertar de novo poderia agir sobre uma opção que você não '
    + 'escolheu.',
  sessAnswerNoField: (label: string) =>
    `"${label}" não abriu um campo para escrever, então nada foi digitado — as palavras iriam para `
    + 'onde a sessão estivesse ouvindo e o enter submeteria o que estivesse em foco. Responda na '
    + 'própria sessão (attach).',
  sessNoFell: 'nada caiu — nenhuma sessão foi perdida com registro de que estava viva.',
  sessBackendUnreadable: 'não foi possível listar as sessões em execução (o tmux não respondeu), então nada foi reaberto — uma sessão ainda viva seria iniciada duas vezes. Tente de novo em instantes.',
  sessFellOpened: (opened: number, skipped: number, held: number) =>
    `${opened} sessão(ões) que caíram reabertas.`
    + (held > 0 ? ` ${held} já estava(m) aberta(s) em outra sessão.` : '')
    + (skipped > 0 ? ` ${skipped} não puderam ser reabertas.` : ''),
  sessFellNoneOpened: (skipped: number) =>
    `nenhuma das ${skipped} sessão(ões) que caíram pôde ser reaberta.`,
  sessFellGone: (count: number) =>
    `${count} sessão(ões) escolhida(s) não está(ão) mais nesse grupo — terminaram, ou outra janela já `
    + 'reabriu. Nada foi aberto.',
  sessFellNonePicked: 'nenhuma sessão foi escolhida, então nada foi reaberto.',
  sessBroadcastRefused: (reason: string, skipped: number) => {
    if (reason === 'no-text') return 'nada foi escrito, então nada foi enviado.'
    if (reason === 'no-selection') return 'nenhuma sessão foi escolhida. Isso nunca quer dizer todas.'
    if (reason === 'too-many') {
      return 'são mais sessões do que uma mensagem alcança de uma vez — escolha menos, ou envie duas vezes.'
    }
    return `nenhuma das ${skipped} sessão(ões) escolhida(s) pode receber um prompt agora — veja o motivo em cada uma.`
  },
  sessBroadcastDone: (sent: number, failed: number, skipped: number) => {
    const parts = [`enviado para ${sent} sessão${sent === 1 ? '' : 'ões'}`]
    if (failed > 0) parts.push(`${failed} recusou`)
    if (skipped > 0) parts.push(`${skipped} não pôde receber`)
    return `${parts.join(', ')}.`
  },
  sessBroadcastReopenSlow:
    'ela foi reaberta mas não subiu a tempo de receber a mensagem — nada foi digitado nela.',
  sessResumeInUse: (holder: string) =>
    `essa conversa já está aberta em ${holder} — abra ela por lá, em vez de colocar um segundo assistente dentro dela.`,
  sessAdoptFailed: (holder: string) =>
    `o assistente que roda essa conversa (${holder}) não encerrou, então foi deixado como estava — nada foi aberto.`,
  sessTakeoverRefused: (reason: TakeoverRefusal) => {
    switch (reason.code) {
      case 'resume-unsupported':
        return `o ${reason.harness} não reabre uma conversa por id, então o assistente que a segura foi deixado como estava.`
      case 'holder-unreachable':
        return `algo está segurando esta conversa${reason.label ? ` (${reason.label})` : ''} e o agentop não consegue encerrar.`
      case 'no-cwd':
        return 'esta conversa não tem diretório para reabrir — provavelmente uma worktree removida.'
    }
  },
  sessContinueConfirm: (harness, pid) =>
    `esta sessão ${harness} ainda está aberta em outro terminal${pid !== undefined ? ` (pid ${pid})` : ''}. Enviar encerra aquele processo e continua a mesma conversa aqui — um turno em andamento é cortado.`,
  sessContinueRefused: (reason, harness) => reason === 'no-conversation'
    ? `este processo ${harness} nunca disse qual conversa está escrevendo, então ela aparece ao vivo e só para leitura — continuar aqui uma conversa adivinhada poderia escrever na errada.`
    : `${harness} não reabre uma conversa pelo id, então esta sessão aparece ao vivo e só para leitura — escreva nela no próprio terminal.`,
  sessContinuedHere: 'continuou aqui — a conversa agora é uma sessão do agentop.',
  sessUntitled: (harness: string, project: string) => (project ? `${harness} em ${project}` : harness),
  sessUnregistered: (handle: string) => `sessão sem registro ${handle}`,
  sessModeUnknown: (harness: string) =>
    `ninguém dirigiu os modos do ${harness}, então o agentop não sabe qual tecla os altera — troque dentro da própria sessão.`,
  sessModeCycled: 'passou para o próximo modo.',
  sessAnswerNeedsText: 'esta opção é um campo para escrever — envie junto com a sua resposta, porque vazia ela é lida como recusar a pergunta.',
  sessKilled: (id: string) => `${id} encerrada.`,
  sessInterrupted: (id: string) => `pedi para ${id} parar o que estava fazendo — a sessão continua de pé.`,
  sessInterruptIdle: (id: string) => `${id} não está trabalhando agora, então não há o que parar.`,
  sessRestoreNone: 'essas sessões não estão mais no registro.',
  sessRestoreDeclined: (n: number) =>
    `${n} ${n === 1 ? 'sessão deixada fechada' : 'sessões deixadas fechadas'} — continuam listadas e reabríveis.`,
  sessRestored: (opened: number, skipped: number) =>
    `${opened} restaurada${opened === 1 ? '' : 's'}${skipped ? `, ${skipped} não deu` : ''}.`,
  sessRestoreFailed: (skipped: number) =>
    `nada pôde ser restaurado${skipped ? ` — ${skipped} sem conversa para reabrir` : ''}.`,
  sessNoTask: 'essa sessão não tem tarefa.',
  sessTaskFinished: (task: string) => `"${task}" marcada como finalizada.`,
  sessTaskUnknown: (task: string) => `nenhuma sessão está sob "${task}", e ela não está na lista de finalizadas.`,
  sessTaskDeleted: (task: string, freed: number) => freed === 0
    ? `"${task}" removida.`
    : `"${task}" removida — ${freed} sessão(ões) mantida(s), agora sem tarefa.`,
  sessTaskReopened: (task: string) => `"${task}" reaberta.`,
  sessKillUnconfirmed: (id: string) =>
    `não deu para confirmar que ${id} foi encerrada — ela pode continuar rodando, então o registro dela foi mantido.`,
  sessRenamed: 'sessão renomeada.',
  sessRenamedBoth: 'renomeada aqui e dentro da sessão.',
  sessRenamedLocalOnly: (why: string) => `renomeada só no agentop — ${why}`,
  sessRenameWhyUnsupported: (harness: string) =>
    `o ${harness} não publica nenhuma forma de renomear uma sessão de fora, então ele mantém o nome dele.`,
  sessRenameWhyExternal:
    'o agentop não iniciou essa sessão, então não há painel onde digitar — ela mantém o nome dela.',
  sessRenameWhyNotRunning:
    'não há nada rodando, então não deu para avisar o harness — ele vai manter o nome que tinha.',
  sessRenameWhyDialog:
    'essa sessão está com uma pergunta aberta, e digitar agora responderia ela. Responda e renomeie de novo para levar o nome adiante.',
  sessRenameWhyUntypable: 'o nome tem quebra de linha, o que não dá para digitar como um comando só.',
  sessRenameWhyFailed: 'a sessão não aceitou a tecla — ela pode ter acabado de terminar.',
  sessAttaching: (title: string, detach: string) =>
    `Anexando a ${title}. Para deixá-la rodando e voltar aqui, aperte ${detach}.`,
  sessNoted: 'nota salva.',
  sessTasked: 'tarefa definida.',
  sessFiled: (task: string) => `arquivada em ${task} — o custo dela soma lá a partir de agora.`,
  sessFileNoConversation: 'o agentop não consegue ver qual conversa é esta sessão externa, então não há o que arquivar — inicie pelo agentop, ou arquive pela web quando a conversa for conhecida.',
  sessFileRefused: (reason: string) => `o board não arquivou: ${reason}.`,
  sessTaskEmpty: (task: string) => `nenhuma sessão está na tarefa "${task}".`,
  sessTaskOpened: (task: string, opened: number, skipped: number, held: number) =>
    `${opened} sessão(ões) de "${task}" reabertas.`
    + (held > 0 ? ` ${held} já estava(m) aberta(s) em outra sessão.` : '')
    + (skipped > 0 ? ` ${skipped} não puderam ser reabertas.` : ''),
  sessTaskNoneOpened: (task: string, skipped: number) =>
    `nenhuma das ${skipped} sessão(ões) de "${task}" pôde ser reaberta.`,
  sessNoRegistryEntry: 'essa sessão não tem registro para atualizar — não foi o agentop que iniciou ela.',
  sessStarted: (name: string) => `${name} iniciada.`,
  sessStartedBg: (name: string) => `${name} iniciada em background.`,
  sessSpawnFailed: (reason: string) => `não deu para iniciar a sessão: ${reason}`,
  sessRewound: 'Conversa restaurada até aquele ponto. Sua próxima mensagem continua dali.',
  sessRewindFailed: reason => reason === 'no-menu'
    ? 'A sessão não abriu o menu de voltar — nada foi alterado.'
    : reason === 'not-found'
      ? 'Essa mensagem não está na lista de voltar da sessão — nada foi alterado.'
      : reason === 'unexpected'
        ? 'A sessão perguntou algo que o agentop não sabe responder, então a volta foi cancelada — nada foi alterado. Use o terminal para esta.'
        : 'Não deu para alcançar a sessão para voltar — nada foi alterado.',
  sessRewindUnsupported: harness => `Restaurar a conversa só está disponível para sessões do Claude Code (esta é ${harness}).`,
  sessSentNow: 'Mensagens da fila enviadas agora.',
  sessSendNowOutcome: (outcome, id) => ({
    sent: 'Entregue agora — a sessão recebeu a mensagem da fila sem parar o turno.',
    interrupted: 'Entregue — a sessão não liberou a vez, então o turno atual foi interrompido para entregar a mensagem.',
    nothing: 'Não havia nada na fila da sessão — a mensagem já tinha sido recebida.',
    stuck: 'Não entregue — a sessão manteve a mensagem na fila mesmo depois de interrompida. Abra o terminal para ver o motivo.',
    'no-focus': 'Não entregue — não foi possível alcançar a caixa de texto da sessão, então nada foi pressionado.',
    failed: `${id} não aceitou a tecla — pode ter acabado de encerrar.`,
  } satisfies Record<SendNowOutcome, string>)[outcome],
  sessSendNowUnsupported: harness => `"Enviar agora" só está disponível para sessões do Claude Code (esta é ${harness}).`,
  sessDiedAtSpawn: (reason: string) => `a sessão terminou assim que começou: ${reason}`,
  sessDiedAtSpawnStatus: (status: number | undefined) =>
    `a sessão terminou assim que começou${status !== undefined ? ` (status ${status})` : ''}`,
  sessNotOnPath: (bin: string, path: string) =>
    `não deu para executar \`${bin}\` — ele está no PATH do servidor agentop? O servidor enxerga: ${path || '(vazio)'}. ` +
    'Se o agentop roda como serviço, rode `agentop restart server` num terminal onde ele funciona.',
  sessNoHarnessOnPath: (path: string) =>
    `O servidor agentop não enxerga nenhum assistente no PATH dele (${path || 'vazio'}). ` +
    'Se ele roda como serviço, rode `agentop restart server` num terminal onde os assistentes funcionam.',
  sessSpawnUnsupported: (harness: string) => `o agentop ainda não inicia ${harness}.`,
  sessSpawnNoResume: (harness: string) => `${harness} não reabre conversa por id.`,
  sessSpawnNoModel: (harness: string) => `${harness} não tem flag de modelo, então não dá para definir um.`,
  sessSpawnNoEffort: (harness: string) => `${harness} não tem flag de effort, então não dá para definir um.`,
  sessSpawnBadEffort: (harness: string, value: string, accepted: string[]) =>
    `${harness} não aceita o effort "${value}". Aceitos: ${accepted.join(', ')}.`,

  sessLs: {
    none: 'Nenhuma sessão.',
    noneRunning: (hidden: number) =>
      `Nada rodando — ${hidden} ${hidden === 1 ? 'sessão retida' : 'sessões retidas'}. Rode \`agentop session ls --all\` para ver.`,
    waiting: (n: number, names: string) =>
      `${n} ${n === 1 ? 'sessão esperando' : 'sessões esperando'} por você: ${names}`,
    blind: (harnesses: string) =>
      `Detecção de aprovação não está disponível para: ${harnesses} — essas sessões aparecem como "aguardando resposta" de qualquer jeito.`,
  },

  dockerMissing: 'docker não instalado',
  dockerUnreachable: 'docker instalado, mas não responde',
  foregroundLater: 'o foreground sobe assim que esta tela fechar.',
  useRestartInstead: 'Use Reiniciar para trocar.',

  optForeground: 'Iniciar (neste terminal)',
  optForegroundHint: 'roda aqui até você sair',
  optBackground: 'Iniciar (background)',
  optBackgroundHint: 'destacado — continua rodando',
  optDockerForeground: 'Iniciar (docker, neste terminal)',
  optDockerForegroundHint: 'em primeiro plano — Ctrl-C para parar',
  optDockerBackground: 'Iniciar (docker, background)',
  optDockerBackgroundHint: 'destacado — o mesmo server, em um container',
  optCentral: 'Iniciar',
  optCentralHint: 'a central do time, em Docker',
  optCentralImage: 'Iniciar (docker · imagem publicada)',
  optCentralImageHint: 'baixa ghcr.io/agentistics/agentistics — sem build, sem clone do repo',
  optCentralBuild: 'Iniciar (docker · build do código)',
  optCentralBuildHint: 'constrói a imagem a partir deste checkout e recria o container',
  centralBlockedImageNoDocker: 'Imagem publicada: precisa de Docker, e `docker` não está no PATH aqui.',
  centralBlockedBuildNoDocker: 'Build do código: precisa de Docker, e `docker` não está no PATH aqui.',
  centralBlockedBuildNoCheckout: 'Build do código: precisa de um checkout do agentistics — aqui só existe o binário instalado. A imagem publicada roda a mesma central.',
  centralBlockedNativeBundled: 'Nativo: precisa de um banco externo. Esta central usa o Mongo embutido, que só o Docker sobe — refaça o setup e escolha uma URI externa para trocar.',
  centralBlockedNativeNoEnv: 'Nativo: esta central ainda não foi configurada, então o banco é desconhecido.',
  optCentralNativeForeground: 'Iniciar (neste terminal)',
  optCentralNativeForegroundHint: 'roda aqui até você sair — sem Docker',
  optCentralNativeBackground: 'Iniciar (background)',
  optCentralNativeBackgroundHint: 'destacado — continua rodando, sem Docker',
  stopRuntime: (runtime) => `Parar (${runtime})`,
  optBootOn: (mech) => (mech ? `Iniciar no boot (${mech})` : 'Iniciar no boot'),
  optBootOnHint: 'registra um serviço systemd de usuário para voltar depois de reiniciar',
  optBootOffHint: 'remove esse registro — o que está rodando agora continua rodando',
  optBootOff: (mech) => (mech ? `Não iniciar no boot (${mech})` : 'Não iniciar no boot'),
  bootConfirmOn: (unit) => `Registrar ${unit} para isto voltar a cada boot?`,
  bootConfirmOff: (unit) =>
    `Remover ${unit}? Ele deixa de trazer isto de volta depois de reiniciar. O que está rodando agora continua rodando.`,
  bootAfterStop: (service, unit) =>
    `${service} está parado, mas ${unit} ainda o inicia no boot. Remover esse registro também?`,
  bootDisabled: (unit) => `${unit} removido — não inicia mais no boot.`,
  bootDisableFailed: (unit) => `Não foi possível remover ${unit}.`,
  setupBlockedCentralUp: 'a central está rodando — pare ela antes de reconfigurá-la',
  optRestart: 'Reiniciar',
  optRestartHint: 'só reinicia — mesmo build',
  optRebuild: 'Reconstruir & reiniciar',
  optRebuildRuntime: (runtime) => `Reconstruir & reiniciar (${runtime})`,
  optRebuildNativeHint: 'recompila o binário (bun run bin) e depois reinicia',
  optRebuildDockerHint: 'reconstrói a imagem e recria o container',
  archiveUnsetHint: 'a preservação do histórico ainda não foi definida — o painel de config define',
  dockerStartFailed: 'o container da máquina não subiu.',
  localStartFailed: 'o server local não voltou a rodar.',
  restartManagerUnreachable: (unit, detail) =>
    `Não deu para reiniciar ${unit}: o systemctl --user não alcança o gerenciador de serviços (${detail}). Nada foi alterado. ` +
    'Abra uma sessão de usuário (ou rode `loginctl enable-linger $USER`), ou pare o server e inicie de novo com `agentop server`.',
  restartNotManaged: (subject, pid, unit, unitState) =>
    `${cap(subject)} (pid ${pid}) não é gerenciado pelo systemd aqui — ${unit} está ${unitState} — então reiniciar a unit o deixaria servindo o código antigo. Nada foi alterado. ` +
    `Pare-o (\`kill ${pid}\`) e rode \`agentop restart server\` de novo, ou inicie-o outra vez com \`agentop server\`.`,
  restartUnchanged: (unit, subject, pid) =>
    `o systemctl disse que ${unit} reiniciou, mas ${subject} continua sendo o pid ${pid} — nada foi substituído, então o código e a config seguem os mesmos. ` +
    `Veja \`systemctl --user status ${unit}\`.`,
  restartSilent: (unit, subject) =>
    `${unit} foi reiniciado, mas ${subject} não voltou dentro da janela de verificação — pode ter falhado ao subir. ` +
    `Logs recentes: \`journalctl --user -u ${unit} -n 50\`.`,
  restartRestarted: (unit, before, after) =>
    `${unit} reiniciado — pid ${before} → ${after}, agora roda o código e a config atuais.`,
  restartStarted: (unit, pid) => `${unit} iniciado (pid ${pid}) — não estava rodando.`,
  restartNotStopped: (pid) =>
    `O server antigo (pid ${pid}) continua rodando — não parou, então nada foi reiniciado. ` +
    `Pare-o você mesmo (\`kill ${pid}\`) e inicie de novo com \`agentop server\`.`,
  centralStarted: 'agentistics central está no ar.',
  centralFailed: 'a central não subiu.',
  centralInitDone: 'central configurada.',
  centralInitFailed: 'o init da central não terminou.',
  connected: 'conectado — esta máquina agora é member.',
  connectFailed: 'não consegui conectar na central.',
  disconnected: 'desconectado — esta máquina voltou para solo.',
  disconnectFailed: 'não consegui desconectar da central.',
  stoppedAll: 'todos os serviços no ar foram parados.',
  stoppedDone: 'serviço parado.',
  soloSet: 'modo solo definido — nada sai desta máquina.',
  archiveSet: (mode) => `preservação do histórico definida como ${mode}.`,
  upgradeDone: 'atualizado, e tudo o que estava no ar foi reiniciado na versão nova.',
  upgradeFailed: (code) => `o upgrade saiu com ${code} — veja a saída acima.`,
  prefsWriteFailed: 'não consegui gravar as preferências.',

  updateCriticalTitle: 'Atualização crítica — instalando automaticamente',
  updateCriticalInstalling: (v) => `a v${v} está sendo instalada em segundo plano; seu terminal está livre.`,
  updateCriticalLog: (p) => `Acompanhe em: ${p}`,
  updateCriticalRunning: 'Uma atualização crítica já está sendo instalada em segundo plano.',
  updateCriticalManualTitle: 'Atualização crítica disponível',
  updateCriticalManualHow: (cmd) => `Instale com ${cmd} — a instalação automática é opt-in (AGENTISTICS_AUTO_UPGRADE=1).`,
  updateCriticalUnsupported: (target) => `A instalação automática não está disponível para ${target} — instale manualmente.`,
  updateCriticalRetryLater: 'Uma atualização crítica falhou antes; ela será tentada de novo mais tarde.',

  upgradeVerifying: '  Verificando o binário baixado…',
  upgradeFromSource: (execPath) => `Upgrade recusado: isto é um checkout do código, então atualizar sobrescreveria ${execPath}. Gere/instale o binário (bun run build:binary).`,
  upgradeInProgress: (pid) => `Já existe uma atualização rodando (pid ${pid}) — nada a fazer.`,
  upgradeLockUnavailable: 'Não consegui escrever o lock de upgrade; seguindo sem ele.',
  upgradeUnsupported: (target) => `Não existe release do agentop para ${target}, então ele não pode se atualizar sozinho.`,
  upgradeManualHow: (url) => `Baixe o binário da sua plataforma e troque na mão: ${url}`,
  upgradeVerifyFailed: (reason) => `Upgrade abortado: ${reason}.`,
  upgradeRolledBack: (backup) => `O binário anterior foi restaurado de ${backup}.`,
  upgradeUntouched: 'O binário instalado não foi tocado.',
  upgradeBackupKept: (backup) => `Binário anterior mantido em ${backup}.`,
  upgradeRestartFailed: (version) => `a v${version} foi instalada, mas alguns serviços NÃO foram reiniciados nela:`,
  upgradeRestartHint: 'Reinicie na mão (ex.: `agentop restart --all`) — eles ainda rodam a versão antiga.',
  upgradeVersionUnconfirmed: (version) =>
    `a v${version} foi instalada e o comando de reinício teve sucesso, mas nada confirmou que ela está realmente no ar ainda:`,

  cancel: 'Cancelar',
  leaveWhich: 'Sair de qual central?',
  leaveAll: 'Sair de todas as centrais',
  leftOne: (endpoint) => `saiu de ${endpoint}`,
  leftAll: (n) => `saiu de todas as ${n} ${n === 1 ? 'central' : 'centrais'} — de volta para solo.`,
  stillConnected: (n) => `ainda conectado a ${n} central(is).`,
  noConnections: 'sem conexão com nenhuma central.',
  ambiguousLeave: (n) => `conectado a ${n} centrais — use --endpoint <url> ou --all.`,
  connectedAs: (user, n) => `conectado como ${user} — ${n} central(is) no total.`,
  updatedExisting: (endpoint) => `atualizou a conexão existente com ${endpoint}`,
  tokenInUse: (endpoint) => `esse token já pertence a ${endpoint}`,
  noMatchEndpoint: (endpoint) => `nenhuma conexão corresponde ao endpoint ${endpoint}`,
  localServerUnknown: 'desconhecido (o server local não está rodando)',
  stateAuthRejected: 'token rejeitado pela central',
  stateNetUnreachable: 'central inacessível',
  stateOk: 'ok',
  neverSynced: 'nunca',

  backupScheduleOff: 'agenda: desligada',
  backupScheduleNoServer: 'agenda: inativa — o servidor não está rodando, então nada vai disparar',
  backupSecretsOmitted: 'Estes NÃO estavam no backup. Restabeleça cada um:',
  backupNoneOnDisk: 'último backup: nenhum (nenhum registro cujo arquivo ainda esteja no disco)',
  backupScheduleSet: schedule => `agenda: ${schedule}`,
  backupLayersSet: layers => `camadas: ${layers}`,
  backupScheduleLayersSet: layers => `camadas da agenda: ${layers}`,
  backupRunOk: bytes => `backup gravado — ${bytes}`,
  rateLimitLabel: 'limite de taxa',
  rateLimitKind: {
    requests: 'requisições',
    tokens: 'tokens',
    'input-tokens': 'tokens de entrada',
    'output-tokens': 'tokens de saída',
    'project-tokens': 'tokens do projeto',
  },
  rateLimitLeft: (remaining, limit) => `${limit === undefined ? remaining : `${remaining}/${limit}`} restantes`,
  rateLimitLimitOnly: limit => `limite ${limit} (restante não informado)`,
  rateLimitUntil: time => `até ${time}`,
  rateLimitRetryAfter: seconds => `tentar de novo em ${seconds}s`,
  rateLimitDropped: n => `${n} ${n === 1 ? 'cabeçalho ilegível' : 'cabeçalhos ilegíveis'}`,
  rateLimitAbsent: (reason, dropped) => {
    switch (reason) {
      case 'not-documented': return 'não informado — este provedor não documenta cabeçalho de limite de taxa'
      case 'unknown-format': return 'não lido — não há formato documentado de cabeçalho de limite de taxa para este provedor'
      case 'no-headers': return 'não informado — a resposta não trouxe cabeçalho de limite de taxa'
      case 'unparseable': return `não lido — ${dropped} ${dropped === 1 ? 'cabeçalho de limite de taxa presente, ilegível' : 'cabeçalhos de limite de taxa presentes, nenhum legível'}`
    }
  },
  engineVerbAbsent: (verb, reason) => {
    const what = ENGINE_VERB_WHAT.pt[verb]
    switch (reason) {
      case 'community-build': return `\`agentop ${verb}\` ${what}, que está no build oficial do agentop e não neste. Baixe em ${OFFICIAL_BUILD_URL}, ou continue usando os harnesses que você já tem — todas as métricas funcionam sem ele.`
      case 'disabled': return `\`agentop ${verb}\` ${what}. Este binário traz o engine, mas AGENTISTICS_ENGINE=0 o desligou — remova essa variável para usar este comando.`
      case 'api-mismatch': return `\`agentop ${verb}\` ${what}, mas o engine deste binário foi construído para outra versão do contrato e não foi carregado — um defeito de release; atualizar o agentop resolve. Todo o resto continua funcionando.`
      case 'load-failed': return `\`agentop ${verb}\` ${what}, mas o engine deste binário falhou ao carregar (o motivo está no log). Todo o resto continua funcionando.`
    }
  },
  engineVerbNotProvided: verb => `\`agentop ${verb}\` ${ENGINE_VERB_WHAT.pt[verb]}, e o engine deste build ainda não oferece esse comando.`,
  engineVersionLine: st => {
    if (st.present) return `engine ${st.manifest.version} (api ${st.manifest.apiVersion})`
    switch (st.reason) {
      case 'community-build': return 'engine: nenhum — build da comunidade'
      case 'disabled': return 'engine: desligado — AGENTISTICS_ENGINE=0'
      case 'api-mismatch': return 'engine: não carregado — versão de contrato incompatível'
      case 'load-failed': return 'engine: não carregado — falhou ao carregar (veja o log)'
    }
  },
}

const TABLE: Record<CliLang, CliStrings> = { en: EN, pt: PT }

export function cliStrings(lang: CliLang): CliStrings {
  return TABLE[lang] ?? EN
}

/**
 * Resolve the CLI language: `--lang en|pt` wins, else `preferences.lang` (shared with the web
 * toggle), else English. Lives here (not in cli-start.ts, its original home) so cli-member.ts can
 * share it without a circular import — cli-start.ts already imports memberConnect/memberLeave
 * from cli-member.ts, so the reverse import would form a cycle.
 */
export async function resolveLang(): Promise<CliLang> {
  const i = process.argv.indexOf('--lang')
  const flag = i >= 0 ? process.argv[i + 1] : undefined
  if (flag === 'pt' || flag === 'en') return flag
  try {
    const { readPreferences } = await import('./preferences')
    const prefs = await readPreferences()
    return prefs.lang === 'pt' ? 'pt' : 'en'
  } catch {
    return 'en'
  }
}
