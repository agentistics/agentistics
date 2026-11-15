/** Test-only: which call sites of the guarded store writers pass a `GuardContext` (shared by the lint and its one-off counter). */
import { callsOf } from './lint-scan.testing'

export const TASK_WRITERS = /\.(?:upsertTask|patchTask|upsertSubtask|registerComposerSubtask)/
export const DELIVERY_WRITER = /\bstore\.update/
export const CARRIES = /\bguard\b|GuardContext|flowContext|unattributedContext|contextOfActor|\bctx\b/

const sites = (src: string) => [...callsOf(src, TASK_WRITERS), ...callsOf(src, DELIVERY_WRITER)]
export const missingContext = (src: string): number => sites(src).filter(c => !CARRIES.test(c.args)).length
export const carryingContext = (src: string): number => sites(src).filter(c => CARRIES.test(c.args)).length
