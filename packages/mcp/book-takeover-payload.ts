export function bookTakeoverPayload(
  args: Record<string, unknown> | undefined,
  proof: { id: string; token: string } | undefined,
): Record<string, unknown> {
  return {
    taskId: args?.taskId,
    bookmarkHash: args?.bookmarkHash,
    ...(typeof args?.lastDeltaHash === "string" ? { lastDeltaHash: args.lastDeltaHash } : {}),
    session: proof,
  };
}
