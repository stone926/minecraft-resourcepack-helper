/**
 * Shared model-preview message-type ids. The webview posts and matches these
 * values; the host's `ModelPreviewMessages.ts` unions are compile-time checked
 * against this module, so adding or renaming a message updates both sides.
 */
export const hostToWebviewMessageTypes = Object.freeze({
  updatePreview: "updatePreview",
  requestScreenshot: "requestScreenshot",
  dispose: "dispose"
});

export const webviewToHostMessageTypes = Object.freeze({
  ready: "ready",
  refreshPreview: "refreshPreview",
  exportImage: "exportImage",
  openResource: "openResource",
  screenshotResult: "screenshotResult",
  screenshotError: "screenshotError",
  renderIssue: "renderIssue"
});
