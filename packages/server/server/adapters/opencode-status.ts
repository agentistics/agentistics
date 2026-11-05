/**
 * opencode-status.ts: what the OpenCode reader could NOT read, kept for `health.ts`.
 * A reader that answers "no sessions" without saying why is how 2.x showed "0 sessions, 0 tokens" for weeks:
 * every failure sets a sentence here, every clean read clears it.
 */
let issue: string | null = null

export function setOpencodeReadIssue(description: string | null): void { issue = description }
export function getOpencodeReadIssue(): string | null { return issue }
