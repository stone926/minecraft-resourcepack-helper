/**
 * Keeps malformed or generated delimiter towers from producing enormous
 * indentation-only edits while remaining far above realistic RSGL nesting.
 */
export const maximumRsglFormattedDelimiterDepth = 64;
