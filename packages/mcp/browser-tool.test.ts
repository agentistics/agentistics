import { describe, expect, test } from "bun:test";
import { browserStatusTool, summaryUrl } from "./browser-tool.js";

const MB = 1024 * 1024;
const NOW = Date.parse("2026-11-15T03:00:00Z");
const body = {
  executable: { found: true, path: "/opt/hs/chrome-headless-shell", kind: "headless-shell", source: "playwright", sentence: "Using /opt/hs (headless-shell, via playwright).", tried: ["/a", "/b"] },
  live: [{
    key: "s-agentop-3f5f", owner: { kind: "session", managedId: "agentop-3f5f" }, phase: "live", pid: 4321,
    startedAt: NOW - 60_000, lastActivityMs: NOW - 30_000, viewers: 1,
    tabs: [{ targetId: "T1", url: "http://localhost:5173/login?token=SECRET#x", title: "Loja", active: true }],
    memory: { basis: "pss", bytes: 210 * MB, action: "ok" }, scope: true, scopeEscaped: false, sandbox: true,
    profileDir: "/home/x/.agentistics/browser/sessions/agentop-3f5f",
  }],
  ceilings: { live: 3, session: 2, personal: 1, tabsSession: 4, tabsPersonal: 8 },
  memory: { available: 4096 * MB, minAvailable: 1536 * MB, measured: true },
  scope: { available: true },
  recentStops: [{ key: "personal", reason: "idle", at: NOW - 5_000 }],
  lastSweep: { at: NOW - 100_000, killed: 1, removedDirs: 2, keptForOtherHost: 0 },
};

describe("agentistics_browser_status", () => {
  test("reduces the host snapshot to the allowlist", () => {
    const a = browserStatusTool(body, NOW);
    expect(a.executable).toEqual({ found: true, path: "/opt/hs/chrome-headless-shell", kind: "headless-shell", source: "playwright", sentence: "Using /opt/hs (headless-shell, via playwright)." });
    expect(a.live).toEqual([{
      owner: "session:agentop-3f5f", phase: "live", pid: 4321, viewers: 1, idleSeconds: 30,
      tabs: [{ url: "http://localhost:5173/login", title: "Loja", active: true }],
      memoryMB: 210, memoryBasis: "pss", scope: true, scopeEscaped: false, sandbox: true,
    }]);
    expect(a.ceilings).toEqual({ live: 3, session: 2, personal: 1, tabsSession: 4, tabsPersonal: 8 });
    expect(a.memory).toEqual({ availableMB: 4096, minAvailableMB: 1536, measured: true });
    expect(a.recentStops).toEqual([{ owner: "personal", reason: "idle", at: "2026-11-15T02:59:55.000Z" }]);
    expect(a.lastSweep).toMatchObject({ killed: 1, removedDirs: 2 });
  });
  test("never leaks a query string, the tried paths or a profile folder", () => {
    const s = JSON.stringify(browserStatusTool(body, NOW));
    for (const leak of ["SECRET", "token=", "#x", "/a\"", "profileDir", ".agentistics/browser"]) expect(s).not.toContain(leak);
  });
  test("no executable says so in words", () => {
    const a = browserStatusTool({ executable: { found: false, reason: "none", tried: ["/x"], sentence: "This computer has no browser agentistics can use." } }, NOW);
    expect(a.executable).toEqual({ found: false, path: null, kind: null, source: null, sentence: "This computer has no browser agentistics can use." });
    expect(a.live).toEqual([]);
  });
  test("garbage in, a well-formed answer out", () => {
    const a = browserStatusTool(null, NOW);
    expect(a.executable.found).toBe(false);
    expect(a.ceilings).toBeNull();
    expect(a.memory.measured).toBe(false);
  });
  test("summaryUrl keeps origin + path", () => {
    expect(summaryUrl("https://a.b:8080/x/y?q=1#h")).toBe("https://a.b:8080/x/y");
    expect(summaryUrl("about:blank")).toBe("about:blank");
  });
});
