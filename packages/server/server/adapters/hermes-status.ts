/**
 * hermes-status.ts: what the Hermes reader could NOT read, kept for `health.ts` — a refused store must
 * not look like "no Hermes sessions".
 */
let issue: string | null = null

export function setHermesReadIssue(description: string | null): void { issue = description }
export function getHermesReadIssue(): string | null { return issue }
