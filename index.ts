/**
 * The engine checkout's entry: what `AGENTISTICS_ENGINE_DIR=<this checkout>` resolves to when the
 * public host generates its slot (`packages/server/scripts/engine-slot.ts`). ONE export, per the
 * contract (`@agentistics/engine-api`, `CreateEngine`).
 */
export { createEngine } from './engine/src/index'
