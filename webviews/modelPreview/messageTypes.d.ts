export declare const hostToWebviewMessageTypes: {
  readonly updatePreview: "updatePreview";
  readonly requestScreenshot: "requestScreenshot";
  readonly dispose: "dispose";
};

export declare const webviewToHostMessageTypes: {
  readonly ready: "ready";
  readonly refreshPreview: "refreshPreview";
  readonly exportImage: "exportImage";
  readonly openResource: "openResource";
  readonly screenshotResult: "screenshotResult";
  readonly screenshotError: "screenshotError";
  readonly renderIssue: "renderIssue";
};
