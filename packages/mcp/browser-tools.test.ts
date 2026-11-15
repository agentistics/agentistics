import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOLDABLE_BROWSER_TOOLS, PROGRESS_EVERY_MS, browserLockBody, progressTokenOf, withProgress } from "./browser-tools.js";
import { browserReply } from "./browser-tool.js";

const SRC = readFileSync(join(import.meta.dir, "agentistics-mcp.ts"), "utf8");

function fakeTimer() {
  let fn: (() => void) | null = null;
  let cleared = false;
  return {
    setInterval: (f: () => void) => { fn = f; return 1; },
    clearInterval: () => { cleared = true; fn = null; },
    fire: () => fn?.(),
    get cleared() { return cleared; },
  };
}

describe("NAVEGADOR S3 MCP — progress while the padlock holds a call", () => {
  test("with a progressToken: one notification per tick while pending, none after; the result is the call's", async () => {
    const t = fakeTimer();
    const sent: any[] = [];
    let release!: (v: string) => void;
    const work = new Promise<string>(r => { release = r; });
    const p = withProgress("tok-1", work, { send: async n => { sent.push(n); }, setInterval: t.setInterval, clearInterval: t.clearInterval });
    t.fire(); t.fire();
    expect(sent.map(n => [n.method, n.params.progressToken, n.params.progress])).toEqual([["notifications/progress", "tok-1", 1], ["notifications/progress", "tok-1", 2]]);
    release("done");
    expect(await p).toBe("done");
    expect(t.cleared).toBe(true);
    t.fire();
    expect(sent).toHaveLength(2);
  });

  test("without a token nothing is sent and no timer runs (a strict client never gets a notification it did not ask for)", async () => {
    const t = fakeTimer();
    let called = false;
    expect(await withProgress(undefined, Promise.resolve(7), { send: async () => { called = true; }, setInterval: (f) => { called = true; return t.setInterval(f); } })).toBe(7);
    expect(called).toBe(false);
  });

  test("a failing send never fails the call; a failing call still clears the timer", async () => {
    const t = fakeTimer();
    const p = withProgress(3, new Promise<number>(r => setTimeout(() => r(1), 5)), { send: async () => { throw new Error("pipe"); }, setInterval: t.setInterval, clearInterval: t.clearInterval });
    t.fire();
    expect(await p).toBe(1);
    const t2 = fakeTimer();
    await expect(withProgress(3, Promise.reject(new Error("x")), { send: async () => {}, setInterval: t2.setInterval, clearInterval: t2.clearInterval })).rejects.toThrow("x");
    expect(t2.cleared).toBe(true);
  });

  test("the tick is inside OpenCode's measured 60 s (≤ 20 s), and the token is read from _meta", () => {
    expect(PROGRESS_EVERY_MS).toBeLessThanOrEqual(20_000);
    expect(progressTokenOf({ params: { _meta: { progressToken: "a" } } })).toBe("a");
    expect(progressTokenOf({ params: { _meta: { progressToken: 4 } } })).toBe(4);
    expect(progressTokenOf({ params: { _meta: { progressToken: {} } } })).toBeUndefined();
    expect(progressTokenOf({ params: {} })).toBeUndefined();
  });

  test("every verb the padlock may hold, and wait_unlock, is wrapped; reads and the lock tool are not in the set", () => {
    for (const v of ["navigate", "back", "forward", "reload", "click", "type", "press", "select", "scroll", "evaluate", "tab_new", "tab_select", "tab_close", "close", "wait_unlock"]) {
      expect(HOLDABLE_BROWSER_TOOLS.has(`agentistics_browser_${v}`)).toBe(true);
    }
    for (const v of ["snapshot", "screenshot", "wait_for", "tabs", "status", "lock"]) expect(HOLDABLE_BROWSER_TOOLS.has(`agentistics_browser_${v}`)).toBe(false);
    expect(SRC).toContain('case "agentistics_browser_wait_unlock":\n        return browserReply(await held(apiSend("POST", "/api/browser/session/wait_unlock", browserSessionBody(args, sessionProof(process.env)))));');
    expect(SRC).toContain("server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {\n  const result = await callTool(req, extra);");
  });
});

describe("NAVEGADOR S3 MCP — the padlock tool says WHO asks", () => {
  test("inside a session: the pane's proof goes along (so the server refuses it)", () => {
    const proof = { id: "s1", token: "t".repeat(64) };
    expect(browserLockBody({ session: "s1", lock: "unlocked" }, proof, { AGENTOP_MANAGED_ID: "s1" })).toEqual({ owner: "s1", lock: "unlocked", session: proof });
  });

  test("inside a session with NO computable proof: still marked as a session — never mistaken for the person", () => {
    expect(browserLockBody({ session: "s1", lock: "unlocked" }, undefined, { AGENTOP_MANAGED_ID: "s1" })).toEqual({ owner: "s1", lock: "unlocked", session: { id: "s1", token: "" } });
    // a harness that filters the environment (codex): found through the ancestor's environ
    const readProc = (p: string) => (p === "/proc/50/environ" ? "AGENTOP_MANAGED_ID=s9\0" : p === "/proc/40/status" ? "PPid:\t50\n" : undefined);
    const b = browserLockBody({ session: "s9", lock: "locked" }, undefined, {}, (p) => readProc(p.replace(/\/proc\/\d+/, (m) => m === `/proc/${process.ppid}` ? "/proc/40" : m)));
    expect(b.session).toEqual({ id: "s9", token: "" });
  });

  test("outside any session: the person (session null); the arguments can never pose as an identity", () => {
    const b = browserLockBody({ session: "s1", lock: "unlocked", session_proof: { id: "x" } }, undefined, {}, () => undefined);
    expect(b).toEqual({ owner: "s1", lock: "unlocked", session: null });
  });

  test("the padlock's answers are read as a sentence, never as an ok:true JSON dump", () => {
    expect(browserReply({ ok: true, performed: false, reason: "person_returned", sentence: "The person used it. Snapshot." })).toEqual({ content: [{ type: "text", text: "The person used it. Snapshot." }] });
    expect(browserReply({ ok: true, locked: false, waitedMs: 5, sentence: "Still using." })).toEqual({ content: [{ type: "text", text: "Still using." }] });
    expect(browserReply({ ok: false, performed: false, error: "person_driving", sentence: "Not done." })).toEqual({ content: [{ type: "text", text: "Not done. (person_driving)" }], isError: true });
  });
});
