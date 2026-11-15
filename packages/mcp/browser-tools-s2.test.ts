import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { browserReply, browserSessionBody } from "./browser-tool.js";

const SRC = readFileSync(join(import.meta.dir, "agentistics-mcp.ts"), "utf8");
const VERBS = ["navigate", "back", "forward", "reload", "snapshot", "click", "type", "press", "select", "scroll", "screenshot", "wait_for", "evaluate", "tabs", "tab_new", "tab_select", "tab_close", "close"];

describe("NAVEGADOR S2 MCP tools", () => {
  test("every verb is a tool that calls ITS OWN session route with the pane proof — and no personal/lock route", () => {
    for (const v of VERBS) {
      expect(SRC).toContain(`name: "agentistics_browser_${v}"`);
      expect(SRC).toContain(`case "agentistics_browser_${v}":\n        return browserReply(await held(apiSend("POST", "/api/browser/session/${v}", browserSessionBody(args, sessionProof(process.env)))));`);
    }
    expect(SRC).not.toContain("/api/browser/personal/");
    // S3: the padlock route is reached by ONE tool only, the person's (refused from inside a session).
    expect(SRC.split('"/api/browser/lock"').length - 1).toBe(1);
  });

  test("descriptions are short and bilingual", () => {
    for (const v of VERBS) {
      const at = SRC.indexOf(`name: "agentistics_browser_${v}"`);
      const desc = /description:\s*\n\s*"([^"]*)"/.exec(SRC.slice(at, at + 1200))![1]!;
      expect(desc.length).toBeLessThan(420);
      expect(desc).toContain(" / ");
    }
  });

  test("the proof is never the model's: a session field in the arguments is replaced", () => {
    const proof = { id: "mine", token: "t".repeat(64) };
    expect(browserSessionBody({ url: "http://a/", session: { id: "other", token: "x" } }, proof)).toEqual({ url: "http://a/", session: proof });
    expect(browserSessionBody(undefined, undefined)).toEqual({ session: null });
    expect(browserSessionBody(["x"], proof)).toEqual({ session: proof });
  });

  test("replies: a refusal is the sentence marked as error; a screenshot is an image; a snapshot is its text", () => {
    expect(browserReply({ ok: false, error: "blocked", sentence: "Refused: x." })).toEqual({ content: [{ type: "text", text: "Refused: x. (blocked)" }], isError: true });
    const shot = browserReply({ ok: true, mime: "image/png", data: "iVBOR", bytes: 4, tab: "T" });
    expect(shot.content[0]).toEqual({ type: "image", data: "iVBOR", mimeType: "image/png" });
    expect(shot.content[1]!.type).toBe("text");
    expect(JSON.stringify(shot.content[1])).not.toContain("iVBOR");
    const snap = browserReply({ ok: true, snapshot: "- button \"Go\" [ref=e5]", refs: 1, truncated: true, omittedRefs: 3, bytes: 25 });
    expect((snap.content[0] as { text: string }).text).toBe("- button \"Go\" [ref=e5]\n\n(refs: 1, truncated — 3 ref(s) left out; 25 bytes)");
    expect(browserReply({ ok: true, url: "u" }).content[0]!.type).toBe("text");
  });
});
