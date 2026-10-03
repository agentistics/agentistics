/**
 * claude-skill.ts — **pure**: the skill agentop installs into `~/.claude/skills/`, and how it knows
 * the file on disk is still the one it wrote.
 *
 * This is the half of the integration that actually gets Claude to propose a fan-out. A hook cannot
 * do it: a hook is a deterministic shell callback on an event, so a hook that wanted to teach this
 * would have to inject the whole lesson into EVERY session, including the thousands that will never
 * start a second assistant. A skill is loaded by the model when its `description` matches the task
 * in front of it, and costs nothing when it does not — which is precisely "activate this by
 * inference", and precisely what was asked for. See `docs/claude-integration.md`.
 *
 * Ownership is a MARKER, not a hash: the file carries a line naming agentop and its version, and
 * `agentop hooks uninstall` removes the file only while that line is present. Delete the line and
 * the file is yours — an installer that deleted a file a user had rewritten would be destroying
 * work, and one that could never remove anything would not be an uninstaller.
 */

/** Bumped when the skill's TEXT changes. `status` reports an older one as stale; `install`
 *  rewrites it (the marker is what says it is ours to rewrite). */
export const SKILL_VERSION = 1

/** The directory under `~/.claude/skills/`. Also the name Claude Code shows in `/skills`. */
export const SKILL_NAME = 'agentop-parallel-sessions'

const MARKER = 'agentop-managed-skill'

/** The ownership line. Written directly under the frontmatter — a key inside the frontmatter would
 *  be an unknown field in someone else's schema, which is exactly what this project refuses to do
 *  to `settings.json`. */
export function skillMarker(version = SKILL_VERSION): string {
  return `<!-- ${MARKER}: v${version} — written by \`agentop hooks install\`. Delete this line to make the file yours; agentop will then never touch or remove it. -->`
}

/** Is this file one agentop may rewrite or delete? */
export function isManagedSkill(content: string): boolean {
  return content.includes(`<!-- ${MARKER}:`)
}

/** The version the file on disk declares, or null when it is not ours (or carries no version). */
export function managedSkillVersion(content: string): number | null {
  const m = new RegExp(`<!-- ${MARKER}: v(\\d+)`).exec(content)
  if (!m || m[1] === undefined) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * The skill document.
 *
 * `harnesses` is passed in rather than imported, so this stays pure and so the file names the
 * assistants THIS machine can actually start — a skill that offers `codex` on a machine without it
 * teaches a command that fails.
 */
export function skillMarkdown(o: { harnesses: readonly string[]; version?: number }): string {
  const version = o.version ?? SKILL_VERSION
  const list = o.harnesses.join(', ')
  const first = o.harnesses[0] ?? 'claude'
  const second = o.harnesses[1] ?? first

  return `---
name: ${SKILL_NAME}
description: Use when a task splits into independent pieces that could be worked on at the same time — the user asks for something to run in parallel, across several repositories, packages or worktrees, or wants pieces handed to other assistants. Proposes the split, writes each session's prompt, and starts them all with \`agentop session batch\` once the user approves.
---

${skillMarker(version)}

# Running work in parallel with agentop

\`agentop\` runs assistant CLIs as background sessions (tmux-backed, so they survive this
conversation ending) and files them under a named task. It is what lets you hand independent pieces
of work to several assistants at once instead of doing them one after another in this session.

Harnesses this machine can start: **${list}**.

## When this applies

Reach for it when the work in front of you is genuinely independent — different repositories,
different packages, a migration per file, one reviewer per subsystem — and each piece is big enough
to be worth its own assistant (roughly: more than a few minutes of work, and no shared state to
coordinate). Ordinary sequential work, anything needing the user in the loop step by step, and
anything you can simply do here does NOT belong in a batch.

## The rule that comes first

**Never start a session without the user's explicit go-ahead.** Propose the split, show the exact
prompts, say how many assistants that is, and wait. Each session is a separate assistant burning its
own tokens; N sessions is roughly N times the cost, and nobody authorised that by asking a question.
If the user says "just do it", that is the go-ahead — take it and run.

## How to propose

State it compactly and completely, so approving it is one word:

> Three independent pieces here. I'd run them as parallel sessions under the task \`auth-refactor\`:
>
> 1. \`${first}\` in \`~/app\` — "refactor the token store to …"
> 2. \`${second}\` in \`~/app\` — "port the tests in packages/api to …"
> 3. \`${first}\` in \`~/docs\` — "update the auth docs to match …"
>
> Start them?

## How to start them

One command, all of them, filed under one task:

\`\`\`bash
agentop session batch --task "auth-refactor" --cwd ~/app --json \\
  --session "${first}: refactor the token store so tokens are hashed at rest; keep the public API" \\
  --session "${second}@~/app/packages/api: port the token tests to the new store" \\
  --session "${first}@~/docs: update the auth page to describe hashed-at-rest tokens"
\`\`\`

- \`--task\` is required and groups the sessions. \`agentop session open "auth-refactor"\` brings the
  whole task back later — including after a reboot.
- \`--cwd\`, \`--model\` and \`--effort\` before the sessions are defaults for all of them; \`@<path>\`
  on a session overrides the directory for that one.
- \`--notify off\` (before the sessions, like \`--model\`) starts them muted: no interruption for them,
  yet they still show as waiting. Use it for workers so only the leader reaches the person.
- \`--json\` prints the started ids as data. Read them from there rather than parsing the prose.
- Every session starts DETACHED. A batch has no single terminal to hand over.
- A session that fails to start does not abort the rest; the JSON reports \`started\` and \`failed\`
  separately. Report both — four that started are four that are running.

### Writing each session's prompt

The prompt is the whole briefing. That session cannot see this conversation, cannot ask you a
question, and cannot see what the others are doing. So each one needs: what to change, where, what
"done" looks like, and what NOT to touch (name the files the other sessions own, so two assistants
do not edit the same file). Prefer one paragraph of plain instruction over a checklist of
one-liners. Keep the sessions in different directories — or at least different files — wherever the
work allows it.

## After starting

\`\`\`bash
agentop session list --json     # id, status, activity, task, cwd for the whole fleet
agentop session attach <id>     # hand the terminal to one of them (the user does this)
agentop session kill <id>       # stop one
agentop session open "<task>"   # reopen every session of a task, later
\`\`\`

\`activity\` is what a session is doing: \`working\`, \`waiting\`, \`waiting-approval\` (it is blocked on
a permission prompt and needs a person), \`exited\`. Tell the user which ones need them; do not
attach on their behalf — attaching takes over the terminal.

## What this is not

It does not make the other assistants report back to you. They work in their own sessions; the user
reads them with \`agentop session attach\` or the cockpit (\`agentop\` → the **sessions** tab). Your
job ends at proposing the split, writing the prompts, starting the batch, and saying what is running
where.
`
}
