export { compileRsglDirectory, compileRsglFile, compileRsglModule, compileRsglProgram, loadRsglSourceFilesFromDirectory, loadRsglSourceFilesFromFile } from "./compilePipeline";
export type { RsglCompileOptions, RsglDirectoryCompileOptions, RsglFileCompileOptions, RsglFileLoadOptions, RsglProgramCompileOptions } from "./compilePipeline";
export { emitRsglFiles, stableJsonStringify, orderJsonValue } from "./emit";
export type { RsglContentEmittedFile, RsglCopyEmittedFile, RsglEmittedFile, RsglEmitOptions } from "./emit";
export { createRsglCompileSnapshot, rsglCompileSnapshotVersion } from "./compileSnapshot";
export type {
  RsglCompileSnapshot,
  RsglCompileSnapshotDiagnostic,
  RsglCompileSnapshotMapping,
  RsglCompileSnapshotOptions,
  RsglCompileSnapshotResource,
  RsglCompileSnapshotSourceAlias
} from "./compileSnapshot";
export {
  DEFAULT_MAX_EVALUATION_ITEMS,
  DEFAULT_MAX_ITEM_MODEL_DEPTH,
  createRsglSemanticConfigurationFingerprint,
  effectiveNamespace,
  resolveRsglCompileConfiguration
} from "./compileConfiguration";
export type {
  ResolvedRsglCompileConfiguration,
  RsglCompileConfigurationOptions
} from "./compileConfiguration";
export {
  isRsglMinecraftVersionText,
  normalizeRsglProjectTarget,
  rsglTargetPackFormatForMinecraftVersion
} from "./targetConfig";
export type {
  RsglNormalizedProjectTarget,
  RsglTargetConfig,
  RsglTargetPackFormat
} from "./targetConfig";
export { parseResourceId, resourceIdToString, resourceOutputPath } from "./resourceIds";
export { canonicalizeAndValidateResourceUnits } from "./validation";
export { inferBlockstateSchemaFromContent } from "./blockstateStateValidation";
export type { RsglBlockstateSchema } from "./validationTypes";
export {
  createCachedBaseDocumentLoader,
  createFileBaseDocumentLoader,
  resolveBaseDocumentPath
} from "./base/loader";
export { compileBaseStatement } from "./base/statement";
export {
  compileDependencyMatchesPath,
  compileDependencyPathContains,
  compileDependencyPatternMatchesPath,
  compileDependencyPatternStructurallyMatchesPath,
  compileDependencyPatternProbePath,
  compileDependencyStructuralWatchPatterns,
  compileDependencyWatchPattern,
  compileDependencyWatchPatternKey,
  normalizeCompileDependencyWatchPattern,
  rebaseCompileDependencyWatchPattern
} from "./compileDependencies";
export type { CompileDependencyWatchPattern } from "./compileDependencies";
export type {
  BaseStatementLike,
  CompileBaseStatementOptions
} from "./base/statement";
export {
  BaseDocumentLoadError
} from "./base/types";
export type {
  BaseDocument,
  BaseDocumentLoader,
  BaseDocumentLoadErrorCode,
  CompileDependency
} from "./base/types";
export type { RsglExternalResourceResolution, RsglResourceContentKind, RsglResourceExistenceKind, RsglResourceValidationOptions, RsglSoundMetadata, RsglTextureMetadata } from "./validation";
export { createRsglWritePlan, resolveRsglOutputPath, writeRsglFiles } from "./write";
export type { RsglWriteDiff, RsglWritePlan, RsglWritePlanEntry, RsglWritePlanOptions, RsglWriteStatus, RsglWriteSummary } from "./write";
export {
  RsglCopySourceReadError,
  RsglOutputFileReadError,
  RsglUnsafeOutputPathError,
  rsglWriteErrorCodes
} from "./writeErrors";
export type { RsglWriteErrorCode } from "./writeErrors";
export type {
  ExpansionFrame,
  BinaryCopyRef,
  ExternalResourceRef,
  JsonValue,
  MergePolicy,
  ResourceContent,
  ResourceId,
  ResourceKind,
  ResourceUnit,
  RsglCompileDiagnostic,
  RsglCompileResult,
  RsglMapping,
  RsglSourceMap,
  TextValue
} from "./ir";
