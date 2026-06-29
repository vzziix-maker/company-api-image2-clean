export const DEFAULT_DOCUMENT_TITLE = "image2生图";
export const ATTENTION_DOCUMENT_TITLE = "🤡";
export const EMPTY_ATTENTION_DOCUMENT_TITLE = "\u200B";
export const TITLE_FRAME_ANCHOR = "\u2060";
export const TITLE_FRAME_SPACE = "\u2007";
export const ATTENTION_DOCUMENT_TITLE_FRAMES = [
  `${TITLE_FRAME_ANCHOR}🤡${TITLE_FRAME_SPACE.repeat(8)}`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(2)}🤡${TITLE_FRAME_SPACE.repeat(6)}`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(4)}🤡${TITLE_FRAME_SPACE.repeat(4)}`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(6)}🤡${TITLE_FRAME_SPACE.repeat(2)}`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(8)}🤡`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(6)}🤡${TITLE_FRAME_SPACE.repeat(2)}`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(4)}🤡${TITLE_FRAME_SPACE.repeat(4)}`,
  `${TITLE_FRAME_ANCHOR}${TITLE_FRAME_SPACE.repeat(2)}🤡${TITLE_FRAME_SPACE.repeat(6)}`,
];

export function pageNeedsAttention(pageDocument = globalThis.document) {
  if (!pageDocument) return false;
  return pageDocument.visibilityState !== "visible" || !pageDocument.hasFocus?.();
}

export function requestBrowserNotificationPermission(browserWindow = globalThis) {
  const NotificationConstructor = browserWindow?.Notification;
  if (!NotificationConstructor) return "unsupported";
  if (NotificationConstructor.permission !== "default") return NotificationConstructor.permission;

  try {
    const permissionRequest = NotificationConstructor.requestPermission?.();
    permissionRequest?.catch?.(() => {});
    return permissionRequest || NotificationConstructor.permission;
  } catch {
    return "blocked";
  }
}

export function sendBrowserCompletionNotification(imageCount = 0, browserWindow = globalThis) {
  const NotificationConstructor = browserWindow?.Notification;
  if (!NotificationConstructor || NotificationConstructor.permission !== "granted") return null;

  try {
    const notification = new NotificationConstructor("图片生成完成", {
      body: `收到 ${imageCount || 0} 张图片。`,
      tag: "image2-generation-complete",
      renotify: true,
    });
    notification.onclick = () => {
      browserWindow.focus?.();
      notification.close?.();
    };
    return notification;
  } catch {
    return null;
  }
}

export function createCompletionReminderBatch() {
  return {
    completedImageCount: 0,
    completedKeys: new Set(),
    notifiableCompletionCount: 0,
    pendingKeys: new Set(),
    wasRunning: false,
  };
}

export function updateCompletionReminderBatch(batch, tasks = []) {
  const previousPendingKeys = batch?.pendingKeys || new Set();
  const previousCompletedKeys = batch?.completedKeys || new Set();
  const nextBatch = {
    completedImageCount: batch?.completedImageCount || 0,
    completedKeys: new Set(previousCompletedKeys),
    notifiableCompletionCount: batch?.notifiableCompletionCount || 0,
    pendingKeys: new Set(),
    wasRunning: Boolean(batch?.wasRunning),
  };

  tasks.forEach((task) => {
    if (!task?.key) return;
    if (task.status === "running") {
      nextBatch.pendingKeys.add(task.key);
      nextBatch.wasRunning = true;
      return;
    }
    if (!previousPendingKeys.has(task.key) || nextBatch.completedKeys.has(task.key)) return;
    nextBatch.completedKeys.add(task.key);
    if (task.status === "success") {
      nextBatch.completedImageCount += task.imageCount || 0;
      nextBatch.notifiableCompletionCount += 1;
    } else if (task.status === "failed") {
      nextBatch.notifiableCompletionCount += 1;
    }
  });

  const shouldNotify =
    nextBatch.wasRunning &&
    previousPendingKeys.size > 0 &&
    nextBatch.pendingKeys.size === 0 &&
    nextBatch.notifiableCompletionCount > 0;
  const imageCount = shouldNotify ? nextBatch.completedImageCount : 0;

  if (nextBatch.wasRunning && previousPendingKeys.size > 0 && nextBatch.pendingKeys.size === 0) {
    return {
      batch: createCompletionReminderBatch(),
      shouldNotify,
      imageCount,
    };
  }

  return { batch: nextBatch, shouldNotify: false, imageCount: 0 };
}
