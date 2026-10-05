import { describe, expect, test } from "bun:test";
import { taskCommentRequest } from "./task-comment-args";

describe("agentistics_task_comment → REST", () => {
  test("no target posts to the task, with no subtaskId", () => {
    expect(taskCommentRequest({ ref: "t-1", body: "hi" })).toEqual({
      path: "/api/tasks/t-1/comments",
      payload: { body: "hi", author: "assistant" },
    });
  });
  test("a subtask or group target is forwarded as subtaskId", () => {
    expect(taskCommentRequest({ ref: "t 1", body: "x", author: "claude:3f5f", subtaskId: " s-9 " })).toEqual({
      path: "/api/tasks/t%201/comments",
      payload: { body: "x", author: "claude:3f5f", subtaskId: "s-9" },
    });
  });
  test("a blank target is the task, never an empty id", () => {
    expect("subtaskId" in taskCommentRequest({ ref: "t", body: "x", subtaskId: "" }).payload).toBe(false);
  });
  test("attachments are forwarded as references; an attachment-only comment has an empty body", () => {
    const att = [{ name: "a.png", path: "/x/attachments/1-a.png" }];
    expect(taskCommentRequest({ ref: "t", attachments: att }).payload).toEqual({
      body: "", author: "assistant", attachments: att,
    });
    expect("attachments" in taskCommentRequest({ ref: "t", body: "x", attachments: [] }).payload).toBe(false);
  });
});

describe('threads and session identity', () => {
  test('threadId posts into a thread; threadTitle opens one (handback by default)', () => {
    expect(taskCommentRequest({ ref: 't', body: 'x', threadId: 'th-1' }).payload.threadId).toBe('th-1')
    expect(taskCommentRequest({ ref: 't', body: 'x', threadTitle: 'Release' }).payload.newThread)
      .toEqual({ title: 'Release', kind: 'handback' })
    expect(taskCommentRequest({ ref: 't', body: 'x', threadTitle: 'B', threadKind: 'block' }).payload.newThread)
      .toEqual({ title: 'B', kind: 'block' })
    // A kind a session may not use is not forwarded as such — the default applies, the server decides.
    expect(taskCommentRequest({ ref: 't', body: 'x', threadTitle: 'T', threadKind: 'topic' }).payload.newThread)
      .toEqual({ title: 'T', kind: 'handback' })
  })
  test('the session proof is forwarded as given, and only when there is one', () => {
    const proof = { id: 's1', token: 'a'.repeat(64) }
    expect(taskCommentRequest({ ref: 't', body: 'x' }, proof).payload.session).toEqual(proof)
    expect(taskCommentRequest({ ref: 't', body: 'x' }).payload.session).toBeUndefined()
  })
})
