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
    const noProc = () => undefined; // hermetic: this suite itself may run inside a managed pane
    expect(sessionProof({ AGENTISTICS_DIR: "/d" }, () => hex, noProc)).toBeUndefined();
    expect(sessionProof({ AGENTOP_MANAGED_ID: "s-1" }, () => { throw new Error("ENOENT"); })).toBeUndefined();
    expect(sessionProof({ AGENTOP_MANAGED_ID: "s-1" }, () => "abcd")).toBeUndefined();
  });
});

import { ancestorSession, environValue } from "./session-proof";

/** A fake /proc: pid -> { ppid, env }. */
function fakeProc(tree: Record<number, { ppid: number; env: Record<string, string> }>) {
  return (path: string): string | undefined => {
    const m = /^\/proc\/(\d+)\/(environ|status)$/.exec(path);
    const node = m ? tree[Number(m[1])] : undefined;
    if (!node) return undefined;
    return m![2] === "environ"
      ? Object.entries(node.env).map(([k, v]) => `${k}=${v}`).join("\0") + "\0"
      : `Name:\tx\nPPid:\t${node.ppid}\n`;
  };
}

describe("session proof: the id survives a harness that filters its MCP's environment", () => {
  const key = new Uint8Array(32).fill(7);
  const hex = Buffer.from(key).toString("hex");
  // Codex 0.161.0 hands an MCP only this (measured), whatever the pane carried.
  const codexMcpEnv = { HOME: "/home/u", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", LOGNAME: "u", PATH: "/bin", SHELL: "/bin/bash", TERM: "xterm", USER: "u" };
  const paneEnv = { AGENTOP_MANAGED_ID: "agentop-abc123", AGENTISTICS_DIR: "/data/throwaway", HOME: "/home/u" };

  test("environ parsing is exact: a longer name or an empty value is not a hit", () => {
    expect(environValue("A=1\0AGENTOP_MANAGED_ID=x\0", "AGENTOP_MANAGED_ID")).toBe("x");
    expect(environValue("XAGENTOP_MANAGED_ID=x\0", "AGENTOP_MANAGED_ID")).toBeUndefined();
    expect(environValue("AGENTOP_MANAGED_ID=\0", "AGENTOP_MANAGED_ID")).toBeUndefined();
  });

  for (const harness of ["claude", "codex", "gemini", "copilot", "kimi", "agy"]) {
    test(`${harness}: the id is found in the environment when the harness passes it, else in the harness process`, () => {
      const seen: string[] = [];
      const tree = {
        500: { ppid: 400, env: { ...paneEnv, HARNESS: harness } },   // the harness itself
        400: { ppid: 300, env: paneEnv },                           // the shell tmux started
        300: { ppid: 1, env: {} },
      };
      // Passed through: no /proc read at all.
      const direct = sessionProof({ ...codexMcpEnv, AGENTOP_MANAGED_ID: "agentop-abc123" }, p => { seen.push(p); return hex; }, () => { throw new Error("no /proc needed"); }, 500);
      expect(direct?.id).toBe("agentop-abc123");
      expect(seen).toEqual(["/home/u/.agentistics/session-identity.key"]);
      // Filtered: the MCP's parent is the harness (pid 500).
      seen.length = 0;
      const viaProc = sessionProof(codexMcpEnv, p => { seen.push(p); return hex; }, fakeProc(tree), 500);
      expect(viaProc).toEqual({ id: "agentop-abc123", token: sessionProofToken(key, "agentop-abc123") });
      // A relocated data dir comes from the same process, not from HOME.
      expect(seen).toEqual(["/data/throwaway/session-identity.key"]);
    });
  }

  test("an intermediate wrapper (node shim, sh -c) is walked through", () => {
    const tree = {
      900: { ppid: 800, env: codexMcpEnv },                       // the wrapper the harness spawned
      800: { ppid: 700, env: codexMcpEnv },
      700: { ppid: 1, env: paneEnv },
    };
    expect(ancestorSession(fakeProc(tree), 900)).toEqual({ id: "agentop-abc123", dir: "/data/throwaway" });
  });

  test("no id anywhere, an unreadable process, a loop or a very deep tree: no proof, never a throw", () => {
    expect(ancestorSession(fakeProc({ 5: { ppid: 1, env: {} } }), 5)).toBeUndefined();
    expect(ancestorSession(() => undefined, 5)).toBeUndefined();
    expect(ancestorSession(fakeProc({ 5: { ppid: 6, env: {} }, 6: { ppid: 5, env: {} } }), 5)).toBeUndefined();
    const deep: Record<number, { ppid: number; env: Record<string, string> }> = {};
    for (let i = 100; i < 200; i++) deep[i] = { ppid: i - 1, env: i === 110 ? paneEnv : {} };
    expect(ancestorSession(fakeProc(deep), 199)).toBeUndefined(); // the id sits past the depth cap
    expect(sessionProof(codexMcpEnv, () => hex, fakeProc({ 5: { ppid: 1, env: {} } }), 5)).toBeUndefined();
  });

  test("an id found in a process but a missing key still yields no proof", () => {
    const tree = { 5: { ppid: 1, env: paneEnv } };
    expect(sessionProof(codexMcpEnv, () => { throw new Error("ENOENT"); }, fakeProc(tree), 5)).toBeUndefined();
  });
});
