import type { ModelPreviewDocument } from "../ir/PreviewDocument";

export interface ScreenshotOptions {
  width?: number;
  height?: number;
  transparentBackground?: boolean;
  includeGrid?: boolean;
  includeAxes?: boolean;
}

export type HostToWebview =
  | { type: "updatePreview"; document: ModelPreviewDocument }
  | { type: "requestScreenshot"; requestId: string; options: ScreenshotOptions };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "exportImage" }
  | { type: "screenshotResult"; requestId: string; pngDataUri: string }
  | { type: "renderIssue"; message: string };
