export type RsglFormattingStyle = "canonical" | "compact" | "expanded";
export type RsglBraceStyle = "sameLine" | "nextLine";

export interface RsglFormattingConfiguration {
  style: RsglFormattingStyle;
  lineWidth: number;
  braceStyle: RsglBraceStyle;
}

export interface RsglFormatOptions extends RsglFormattingConfiguration {
  tabSize: number;
  insertSpaces: boolean;
  trimTrailingWhitespace: boolean;
  trimFinalNewlines: boolean;
  /**
   * `undefined` preserves whether the source ends in a newline. `true`
   * requests one final newline after optional trimming.
   */
  insertFinalNewline?: boolean;
}

export interface RsglFormattingStyleRules {
  maxBlankLines: number;
  spaceInsideBraces: boolean;
  compactEmptyBodies: boolean;
  expandDelimitedValues: boolean;
}

export const defaultRsglFormattingConfiguration: Readonly<RsglFormattingConfiguration> = {
  style: "canonical",
  lineWidth: 100,
  braceStyle: "sameLine"
};

export const defaultRsglFormatOptions: Readonly<RsglFormatOptions> = {
  ...defaultRsglFormattingConfiguration,
  tabSize: 2,
  insertSpaces: true,
  trimTrailingWhitespace: true,
  trimFinalNewlines: false
};

const styleRules: Readonly<Record<RsglFormattingStyle, RsglFormattingStyleRules>> = {
  canonical: {
    maxBlankLines: 1,
    spaceInsideBraces: true,
    compactEmptyBodies: true,
    expandDelimitedValues: false
  },
  compact: {
    maxBlankLines: 0,
    spaceInsideBraces: false,
    compactEmptyBodies: true,
    expandDelimitedValues: false
  },
  expanded: {
    maxBlankLines: 1,
    spaceInsideBraces: true,
    compactEmptyBodies: false,
    expandDelimitedValues: true
  }
};

export function rsglFormattingStyleRules(
  style: RsglFormattingStyle
): Readonly<RsglFormattingStyleRules> {
  return styleRules[style];
}

export function normalizeRsglFormattingConfiguration(
  value: unknown
): RsglFormattingConfiguration {
  const candidate = isRecord(value) ? value : {};
  return {
    style: isRsglFormattingStyle(candidate.style)
      ? candidate.style
      : defaultRsglFormattingConfiguration.style,
    lineWidth: boundedInteger(
      candidate.lineWidth,
      40,
      240,
      defaultRsglFormattingConfiguration.lineWidth
    ),
    braceStyle: isRsglBraceStyle(candidate.braceStyle)
      ? candidate.braceStyle
      : defaultRsglFormattingConfiguration.braceStyle
  };
}

export function normalizeRsglFormatOptions(
  value: number | Partial<RsglFormatOptions> | undefined
): RsglFormatOptions {
  if (typeof value === "number") {
    return {
      ...defaultRsglFormatOptions,
      tabSize: boundedInteger(value, 1, 16, defaultRsglFormatOptions.tabSize)
    };
  }

  const candidate = value ?? {};
  return {
    ...normalizeRsglFormattingConfiguration(candidate),
    tabSize: boundedInteger(
      candidate.tabSize,
      1,
      16,
      defaultRsglFormatOptions.tabSize
    ),
    insertSpaces: typeof candidate.insertSpaces === "boolean"
      ? candidate.insertSpaces
      : defaultRsglFormatOptions.insertSpaces,
    trimTrailingWhitespace: typeof candidate.trimTrailingWhitespace === "boolean"
      ? candidate.trimTrailingWhitespace
      : defaultRsglFormatOptions.trimTrailingWhitespace,
    trimFinalNewlines: typeof candidate.trimFinalNewlines === "boolean"
      ? candidate.trimFinalNewlines
      : defaultRsglFormatOptions.trimFinalNewlines,
    insertFinalNewline: typeof candidate.insertFinalNewline === "boolean"
      ? candidate.insertFinalNewline
      : undefined
  };
}

export function isRsglFormattingStyle(value: unknown): value is RsglFormattingStyle {
  return value === "canonical" || value === "compact" || value === "expanded";
}

export function isRsglBraceStyle(value: unknown): value is RsglBraceStyle {
  return value === "sameLine" || value === "nextLine";
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
