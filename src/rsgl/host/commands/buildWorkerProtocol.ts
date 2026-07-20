import type {
  RsglBuildPreviewMessages,
  RsglBuildPreviewResult,
  RsglPreparedBuildResult
} from "../../../../packages/rsgl-core/src/build";
import type {
  CompileDependency,
  RsglCompileDiagnostic,
  RsglEmittedFile,
  RsglMaterializationProject,
  RsglWriteErrorCode
} from "../../../../packages/rsgl-core/src/compiler";
import type { RsglGlobalExternConfigEntry } from "../../../../packages/rsgl-core/src/externDeclarations";
import type { RsglCompileConfigurationOptions } from "../../../../packages/rsgl-core/src/compiler/compileConfiguration";

export interface RsglWorkerValidationConfiguration {
  /** Canonical target pack used by `extern local` resolution. */
  outputPackRoot?: string | null;
  excludedLocalResourcePaths?: string[];
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
  globalExterns?: RsglGlobalExternConfigEntry[];
  checkExternExistence?: boolean;
}

/** Serializable compile configuration and installed stdlib path captured once per worker request. */
export type RsglWorkerCompileConfiguration = RsglCompileConfigurationOptions & {
  stdlibRoot: string;
};

export interface RsglWorkerBuildContext {
  source: {
    kind: "file" | "directory";
    path: string;
  };
  validationAnchor: string;
  outputRoot: string;
  sourceMaps?: boolean;
  manifest?: boolean;
  previewMessages?: RsglBuildPreviewMessages;
  materializationProject?: RsglMaterializationProject;
  materializationSourceRoot?: string;
  adoptUnownedIdentical?: boolean;
}

export interface RsglWorkerCompileDirectoryContext {
  sourceRoot: string;
  validationAnchor: string;
  sourceMaps?: boolean;
  manifest?: boolean;
}

export interface RsglWorkerCompileResult {
  success: boolean;
  diagnostics: RsglCompileDiagnostic[];
  dependencies: CompileDependency[];
  emittedFiles: RsglEmittedFile[];
}

export interface RsglWorkerTaskMap {
  prepareBuild: {
    payload: RsglWorkerBuildContext & RsglWorkerValidationConfiguration & RsglWorkerCompileConfiguration;
    result: RsglPreparedBuildResult;
  };
  previewBuild: {
    payload: RsglWorkerBuildContext & RsglWorkerValidationConfiguration & RsglWorkerCompileConfiguration;
    result: RsglBuildPreviewResult;
  };
  compileDirectory: {
    payload: RsglWorkerCompileDirectoryContext & RsglWorkerValidationConfiguration & RsglWorkerCompileConfiguration;
    result: RsglWorkerCompileResult;
  };
}

export type RsglWorkerTaskKind = keyof RsglWorkerTaskMap;

export type RsglWorkerRequest<K extends RsglWorkerTaskKind = RsglWorkerTaskKind> = {
  kind: K;
  payload: RsglWorkerTaskMap[K]["payload"];
};

export type RsglAnyWorkerRequest = {
  [K in RsglWorkerTaskKind]: RsglWorkerRequest<K>;
}[RsglWorkerTaskKind];

export interface RsglWorkerRequestEnvelope {
  request: RsglAnyWorkerRequest;
  cancellationBuffer: SharedArrayBuffer;
}

export type RsglWorkerSuccess<K extends RsglWorkerTaskKind = RsglWorkerTaskKind> = {
  type: "success";
  kind: K;
  result: RsglWorkerTaskMap[K]["result"];
};

export interface RsglWorkerCancelled {
  type: "cancelled";
}

export type RsglWorkerFailureCode = RsglWriteErrorCode | "rsgl.unknown";

export type RsglWorkerFailureArg = string | number | boolean;

export interface RsglWorkerFailure {
  type: "error";
  code: RsglWorkerFailureCode;
  args: RsglWorkerFailureArg[];
  message: string;
  stack?: string;
}

export type RsglWorkerResponse<K extends RsglWorkerTaskKind = RsglWorkerTaskKind> =
  | RsglWorkerSuccess<K>
  | RsglWorkerCancelled
  | RsglWorkerFailure;

export type RsglAnyWorkerResponse = {
  [K in RsglWorkerTaskKind]: RsglWorkerSuccess<K>;
}[RsglWorkerTaskKind] | RsglWorkerCancelled | RsglWorkerFailure;

export type RsglWorkerOutcome<K extends RsglWorkerTaskKind> =
  | RsglWorkerSuccess<K>
  | RsglWorkerCancelled;
