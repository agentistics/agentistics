import { describe, expect, test } from "bun:test";
import { sessionRoleBody } from "./session-role-args";

describe("agentistics_session_role → REST", () => {
  test("forwards retirePredecessor only when it is a non-blank string", () => {
    expect(sessionRoleBody({ role: "leader", retirePredecessor: " abc " }, null))
      .toEqual({ role: "leader", retirePredecessor: "abc", session: null });
    expect("retirePredecessor" in sessionRoleBody({ role: "leader", retirePredecessor: "  " }, null)).toBe(false);
    expect("retirePredecessor" in sessionRoleBody({ role: "leader" }, null)).toBe(false);
  });
  test("keeps ref, role and the session proof (always present)", () => {
    const proof = { id: "m1", token: "t" };
    expect(sessionRoleBody({ ref: "x", role: "worker" }, proof)).toEqual({ ref: "x", role: "worker", session: proof });
    expect(sessionRoleBody({}, null)).toEqual({ session: null });
  });
});
