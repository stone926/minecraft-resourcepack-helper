/** Stable public facade for transport-neutral RSGL LSP feature adapters. */
export {
  clampOffset,
  type RsglDocumentCompletionDeps,
  type RsglDocumentLanguageIntelligenceDeps,
  type RsglLspDocument
} from "./serverCoreDocuments";
export type { RsglLocationTargetDocument } from "./serverCoreLocations";
export * from "./serverCoreCompletion";
export * from "./serverCoreDiagnostics";
export * from "./serverCoreFormatting";
export * from "./serverCoreLanguageIntelligence";
export * from "./serverCoreNavigation";
export * from "./serverCoreRename";
export * from "./serverCoreSemanticTokens";
export * from "./serverCoreSettings";
