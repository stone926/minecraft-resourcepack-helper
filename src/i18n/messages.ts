export type LocalizedMessageArg = string | number | boolean;

export interface LocalizedMessage {
  message: string;
  args?: LocalizedMessageArg[];
  comment?: string | string[];
}

export function lm(message: string, ...args: LocalizedMessageArg[]): LocalizedMessage {
  return args.length > 0 ? { message, args } : { message };
}

export const modelPreviewWebviewMessages = [
  lm("Model Preview"),
  lm("Reset"),
  lm("Reset view"),
  lm("Refresh"),
  lm("Refresh preview"),
  lm("View preset"),
  lm("3/4"),
  lm("Front"),
  lm("Back"),
  lm("Left"),
  lm("Right"),
  lm("Top"),
  lm("Bottom"),
  lm("Perspective / orthographic"),
  lm("Persp"),
  lm("Ortho"),
  lm("Display mode"),
  lm("Texture"),
  lm("Solid"),
  lm("Wire"),
  lm("Grid"),
  lm("Axes"),
  lm("Export"),
  lm("Export PNG"),
  lm("Resize details panel"),
  lm("Issues"),
  lm("Dependencies"),
  lm("Width"),
  lm("Height"),
  lm("Transparent"),
  lm("Background"),
  lm("Cancel"),
  lm("Width and height must be 1-8192 px."),
  lm("No issues"),
  lm("error"),
  lm("warning"),
  lm("info"),
  lm("model"),
  lm("texture"),
  lm("texture metadata"),
  lm("pack metadata"),
  lm("configuration"),
  lm("Texture load failed: {0}"),
  lm("Renderer has been disposed")
] as const;
