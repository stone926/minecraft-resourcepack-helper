export { compileRsglDirectory, compileRsglFile, compileRsglModule, compileRsglProgram, loadRsglSourceFilesFromDirectory, loadRsglSourceFilesFromFile } from "./compiler";
export type { RsglCompileOptions, RsglDirectoryCompileOptions, RsglFileCompileOptions, RsglFileLoadOptions, RsglProgramCompileOptions } from "./compiler";
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
export { parseResourceId, resourceIdToString, resourceOutputPath } from "./resourceIds";
export { canonicalizeAndValidateResourceUnits, validateResourceUnits } from "./validation";
export { inferBlockstateSchemaFromContent } from "./blockstateStateValidation";
export type { RsglBlockstateSchema } from "./blockstateStateValidation";
export {
  createCachedBaseDocumentLoader,
  createFileBaseDocumentLoader,
  resolveBaseDocumentPath
} from "./base/loader";
export { compileBaseStatement } from "./base/statement";
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
export type { RsglResourceContentKind, RsglResourceExistenceKind, RsglResourceValidationOptions, RsglSoundMetadata, RsglTextureMetadata } from "./validation";
export { createRsglWritePlan, resolveRsglOutputPath, writeRsglFiles } from "./write";
export type { RsglWriteDiff, RsglWritePlan, RsglWritePlanEntry, RsglWritePlanOptions, RsglWriteStatus, RsglWriteSummary } from "./write";
export type {
  ExpansionFrame,
  BinaryCopyRef,
  ExternalResourceKind,
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
