import { historicalWireRow, readCompactFleetResponse, type FleetWire } from '@agentistics/core'

export const INITIAL_FLEET_SESSION_LIMIT = 15

/** Publish the first GET window while older hosts' closed-history pages are still loading. */
export async function readFleetInPhases(
  raw: unknown,
  pageUrl: (offset: number) => string,
  verifyUrl: string,
  previous: FleetWire['sessions'],
  onInitial?: (wire: FleetWire) => void,
): Promise<FleetWire> {
  if (onInitial) {
    onInitial(await readCompactFleetResponse(raw, pageUrl, false))
    // Give the browser a scheduling turn before parsing the next history page.
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return readCompactFleetResponse(raw, pageUrl, true, verifyUrl, previous)
}

/** The server's boot phase and a client's unfinished history pages are both partial answers. */
export function hasPendingFleetHistory(
  fleet: { historyLoading?: boolean; closedTotal?: number; rows: readonly { id: string; state?: string }[] },
  historyRequested: boolean,
): boolean {
  return fleet.historyLoading === true || (historyRequested && (fleet.closedTotal ?? 0) > fleet.rows.filter(historicalWireRow).length)
}
