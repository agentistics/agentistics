/**
 * `@agentistics/engine-api` is Apache-2.0 and may import no platform package, so it RE-DECLARES the
 * few host types its contract names (`mirrors.ts`, `host.ts`). This file is where the host proves
 * the two still agree: every assertion below is checked by `tsc`, so a drift fails the public build
 * at the place it happens. The runtime `it` blocks only keep the file a test.
 */
import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER, type AgentisticsEvent, type HarnessId, type ProviderId } from '@agentistics/core'
import type { CapabilityState } from '@agentistics/core'
import type {
  CapabilityName,
  EngineCapabilityState,
  EngineEvent,
  EngineHealthIssue,
  HarnessId as ApiHarnessId,
  ProviderId as ApiProviderId,
  ReadJsonLimited,
  SafeError,
} from '@agentistics/engine-api'
import type { HealthIssue } from '@agentistics/core'
import type { Capabilities } from '../exposure'
import type { readJsonLimited } from '../limits'
import type { safeError } from '../errors'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assignable<From, To> = [From] extends [To] ? true : false
const ok = <T extends true>(): T => true as T

// Equal unions — a harness, provider or capability added on either side fails here.
ok<Equal<HarnessId, ApiHarnessId>>()
ok<Equal<ProviderId, ApiProviderId>>()
ok<Equal<keyof Capabilities, CapabilityName>>()

// The host's richer types are ASSIGNABLE to the contract's minimal mirrors.
ok<Assignable<AgentisticsEvent, EngineEvent>>()
ok<Assignable<CapabilityState, EngineCapabilityState>>()
ok<Assignable<HealthIssue, EngineHealthIssue>>()
ok<Assignable<typeof readJsonLimited, ReadJsonLimited>>()
ok<Assignable<typeof safeError, SafeError>>()

describe('engine-api mirrors', () => {
  it('lists the same harnesses the host orders', () => {
    const ids: readonly ApiHarnessId[] = HARNESS_ORDER
    expect(ids.length).toBe(HARNESS_ORDER.length)
  })
})
