import { describe, expect, test } from "bun:test";
import { sessionProof, sessionProofToken } from "./session-proof";

describe("session proof", () => {
  const key = new Uint8Array(32).fill(7);
  test("the same vector the server pins", () => {
    expect(sessionProofToken(key, "s-1")).toBe("bc97f010681d2e7ad5c645e0b8c922492578cc7351241eb4ec3e609b3d686b53");
  });
  test("reads the key from the data dir; no id or no key means no proof", () => {
    const hex = Buffer.from(key).toString("hex");
    const seen: string[] = [];
    const p = sessionProof({ AGENTOP_MANAGED_ID: "s-1", AGENTISTICS_DIR: "/d" }, path => { seen.push(path); return hex; });
    expect(p).toEqual({ id: "s-1", token: sessionProofToken(key, "s-1") });
    expect(seen).toEqual(["/d/session-identity.key"]);
    expect(sessionProof({ AGENTISTICS_DIR: "/d" }, () => hex)).toBeUndefined();
    expect(sessionProof({ AGENTOP_MANAGED_ID: "s-1" }, () => { throw new Error("ENOENT"); })).toBeUndefined();
    expect(sessionProof({ AGENTOP_MANAGED_ID: "s-1" }, () => "abcd")).toBeUndefined();
  });
});
