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
