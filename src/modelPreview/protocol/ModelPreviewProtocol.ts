import type { LocalizedMessageArg } from "../../i18n/messages";
import type { PreviewRange, WebviewModelPreviewDocument } from "../ir/PreviewDocument";

export interface ScreenshotOptions {
  width?: number;
  height?: number;
  transparentBackground?: boolean;
  backgroundColor?: string;
  includeGrid?: boolean;
  includeAxes?: boolean;
}

export interface ModelPreviewError {
  code: string;
  message: string;
}

export interface WebviewLocalizedMessage {
  code: string;
  args?: LocalizedMessageArg[];
}

export type HostToWebview =
  | { type: "updatePreview"; document: WebviewModelPreviewDocument }
  | { type: "requestScreenshot"; requestId: string; options: ScreenshotOptions }
  | { type: "dispose" };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "refreshPreview" }
  | { type: "exportImage"; options: ScreenshotOptions }
  | { type: "openResource"; uri: string; range?: PreviewRange }
  | { type: "screenshotResult"; requestId: string; pngDataUri: string }
  | { type: "screenshotError"; requestId: string; error: ModelPreviewError }
  | ({ type: "renderIssue" } & WebviewLocalizedMessage);

export const hostToWebviewMessageTypes = defineMessageTypes<HostToWebview["type"]>({
  updatePreview: "updatePreview",
  requestScreenshot: "requestScreenshot",
  dispose: "dispose"
});

export const webviewToHostMessageTypes = defineMessageTypes<WebviewToHost["type"]>({
  ready: "ready",
  refreshPreview: "refreshPreview",
  exportImage: "exportImage",
  openResource: "openResource",
  screenshotResult: "screenshotResult",
  screenshotError: "screenshotError",
  renderIssue: "renderIssue"
});

function defineMessageTypes<T extends string>(types: { readonly [K in T]: K }): Readonly<{ [K in T]: K }> {
  return Object.freeze(types);
}
