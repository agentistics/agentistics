import { describe, expect, test } from "bun:test";
import { attachCommentPayload, checkAttachSize, planTaskAttach } from "./task-attach-args";

describe("agentistics_task_attach planning", () => {
  test("a valid call is normalised and de-duplicated", () => {
    expect(planTaskAttach({ ref: " t-1 ", sessionId: "abc", files: ["/a/x.PNG", "/a/x.PNG", "/a/y.pdf"], subtaskId: " s1 ", note: "ok" }))
      .toEqual({ ok: true, ref: "t-1", sessionId: "abc", files: ["/a/x.PNG", "/a/y.pdf"], subtaskId: "s1", note: "ok" });
  });
  test.each([
    [{ sessionId: "a", files: ["/x.png"] }, /ref/],
    [{ ref: "t", files: ["/x.png"] }, /sessionId/],
    [{ ref: "t", sessionId: "a", files: [] }, /at least one/],
    [{ ref: "t", sessionId: "a", files: Array.from({ length: 11 }, (_, i) => `/f${i}.png`) }, /At most 10/],
    [{ ref: "t", sessionId: "a", files: ["/etc/passwd"] }, /not an image, video or PDF/],
    [{ ref: "t", sessionId: "a", files: ["/x.png", "/notes.txt"] }, /notes\.txt/],
  ])("refuses %j in a sentence", (args, re) => {
    const p = planTaskAttach(args);
    expect(p.ok).toBe(false);
    expect(p.ok ? "" : p.message).toMatch(re);
  });
  test("size limits", () => {
    expect(checkAttachSize("/a.png", 1000)).toBeNull();
    expect(checkAttachSize("/a.png", 0)).toMatch(/empty/);
    expect(checkAttachSize("/a.png", 21 * 1024 * 1024)).toMatch(/20 MB/);
  });
  test("the comment carries the references, the producing session and the target", () => {
    const plan = planTaskAttach({ ref: "t", sessionId: "abcdef0123456789", files: ["/x.png"], subtaskId: "s" });
    if (!plan.ok) throw new Error("plan");
    expect(attachCommentPayload(plan, [{ name: "x.png", path: "/d/1-x.png" }])).toEqual({
      body: "", author: "session:abcdef012345", sessionId: "abcdef0123456789",
      attachments: [{ name: "x.png", path: "/d/1-x.png" }], subtaskId: "s",
    });
  });
});
