import assert from "node:assert/strict";

import {
  ATTENTION_DOCUMENT_TITLE,
  ATTENTION_DOCUMENT_TITLE_FRAMES,
  createCompletionReminderBatch,
  DEFAULT_DOCUMENT_TITLE,
  EMPTY_ATTENTION_DOCUMENT_TITLE,
  pageNeedsAttention,
  requestBrowserNotificationPermission,
  sendBrowserCompletionNotification,
  TITLE_FRAME_ANCHOR,
  TITLE_FRAME_SPACE,
  updateCompletionReminderBatch,
} from "../src/notification-reminders.js";

assert.equal(DEFAULT_DOCUMENT_TITLE, "Jomage2");
assert.equal(ATTENTION_DOCUMENT_TITLE, "🤡");
assert.equal(EMPTY_ATTENTION_DOCUMENT_TITLE, "\u200B");
assert.notEqual(EMPTY_ATTENTION_DOCUMENT_TITLE.trim(), "");
assert.equal(TITLE_FRAME_ANCHOR, "\u2060");
assert.equal(TITLE_FRAME_SPACE, "\u2007");
assert.deepEqual(ATTENTION_DOCUMENT_TITLE_FRAMES, [
  `${TITLE_FRAME_ANCHOR}🤡${TITLE_FRAME_SPACE.repeat(8)}`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(2)}🤡${TITLE_FRAME_SPACE.repeat(6)}`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(4)}🤡${TITLE_FRAME_SPACE.repeat(4)}`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(6)}🤡${TITLE_FRAME_SPACE.repeat(2)}`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(8)}🤡`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(6)}🤡${TITLE_FRAME_SPACE.repeat(2)}`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(4)}🤡${TITLE_FRAME_SPACE.repeat(4)}`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(2)}🤡${TITLE_FRAME_SPACE.repeat(6)}`,
]);
assert.equal(ATTENTION_DOCUMENT_TITLE_FRAMES.every((frame) => frame.includes("🤡")), true);
assert.equal(ATTENTION_DOCUMENT_TITLE_FRAMES.some((frame) => frame.includes("·")), false);
assert.equal(
  ATTENTION_DOCUMENT_TITLE_FRAMES.map((frame) => frame.replaceAll(TITLE_FRAME_ANCHOR, "").replaceAll(TITLE_FRAME_SPACE, " "))[0],
  "🤡        ",
);
assert.equal(
  ATTENTION_DOCUMENT_TITLE_FRAMES.map((frame) => frame.replaceAll(TITLE_FRAME_ANCHOR, "").replaceAll(TITLE_FRAME_SPACE, " "))[1],
  "  🤡      ",
);

assert.equal(pageNeedsAttention({ visibilityState: "visible", hasFocus: () => true }), false);
assert.equal(pageNeedsAttention({ visibilityState: "hidden", hasFocus: () => true }), true);
assert.equal(pageNeedsAttention({ visibilityState: "visible", hasFocus: () => false }), true);

let permissionRequested = false;
class MockNotification {
  static permission = "default";
  static requestPermission() {
    permissionRequested = true;
    MockNotification.permission = "granted";
    return Promise.resolve("granted");
  }

  constructor(title, options) {
    this.title = title;
    this.options = options;
  }
}

requestBrowserNotificationPermission({ Notification: MockNotification });
assert.equal(permissionRequested, true);

const notification = sendBrowserCompletionNotification(4, { Notification: MockNotification, focus() {} });
assert.equal(notification.title, "图片生成完成");
assert.equal(notification.options.body, "收到 4 张图片。");
assert.equal(notification.options.tag, "image2-generation-complete");

let batch = createCompletionReminderBatch();
let batchResult = updateCompletionReminderBatch(batch, [
  { key: "task-a", status: "running", imageCount: 0 },
  { key: "task-b", status: "running", imageCount: 0 },
]);
assert.equal(batchResult.shouldNotify, false);
batch = batchResult.batch;

batchResult = updateCompletionReminderBatch(batch, [
  { key: "task-a", status: "success", imageCount: 2 },
  { key: "task-b", status: "running", imageCount: 0 },
]);
assert.equal(batchResult.shouldNotify, false);
batch = batchResult.batch;

batchResult = updateCompletionReminderBatch(batch, [
  { key: "task-a", status: "success", imageCount: 2 },
  { key: "task-b", status: "success", imageCount: 3 },
]);
assert.equal(batchResult.shouldNotify, true);
assert.equal(batchResult.imageCount, 5);

batch = createCompletionReminderBatch();
batchResult = updateCompletionReminderBatch(batch, [
  { key: "task-c", status: "running", imageCount: 0 },
  { key: "task-d", status: "running", imageCount: 0 },
]);
batch = batchResult.batch;
batchResult = updateCompletionReminderBatch(batch, [
  { key: "task-c", status: "success", imageCount: 1 },
  { key: "task-d", status: "failed", imageCount: 0 },
]);
assert.equal(batchResult.shouldNotify, true);
assert.equal(batchResult.imageCount, 1);

batch = createCompletionReminderBatch();
batchResult = updateCompletionReminderBatch(batch, [
  { key: "task-e", status: "running", imageCount: 0 },
]);
batch = batchResult.batch;
batchResult = updateCompletionReminderBatch(batch, [
  { key: "task-e", status: "failed", imageCount: 0 },
]);
assert.equal(batchResult.shouldNotify, true);
assert.equal(batchResult.imageCount, 0);

batch = createCompletionReminderBatch();
batchResult = updateCompletionReminderBatch(batch, [
  { key: "task-f", status: "running", imageCount: 0 },
]);
batch = batchResult.batch;
batchResult = updateCompletionReminderBatch(batch, [
  { key: "task-f", status: "canceled", imageCount: 0 },
]);
assert.equal(batchResult.shouldNotify, false);

console.log("notification reminder tests passed");
