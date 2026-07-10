import type {
  RsglBuildPreviewResult,
  RsglPreparedBuildResult
} from "../../../../packages/rsgl-core/src/build";
import type {
  CompileDependency,
  RsglCompileDiagnostic,
  RsglEmittedFile
} from "../../../../packages/rsgl-core/src/compiler";
import type { RsglGlobalExternConfigEntry } from "../../../../packages/rsgl-core/src/externDeclarations";

export interface RsglWorkerValidationConfiguration {
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
  globalExterns?: RsglGlobalExternConfigEntry[];
  checkExternExistence?: boolean;
}

export interface RsglWorkerBuildContext {
  source: {
    kind: "file" | "directory";
    path: string;
  };
  validationAnchor: string;
  outputRoot: string;
  sourceMaps?: boolean;
  manifest?: boolean;
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
    payload: RsglWorkerBuildContext & RsglWorkerValidationConfiguration;
    result: RsglPreparedBuildResult;
  };
  previewBuild: {
    payload: RsglWorkerBuildContext & RsglWorkerValidationConfiguration;
    result: RsglBuildPreviewResult;
  };
  compileDirectory: {
    payload: RsglWorkerCompileDirectoryContext & RsglWorkerValidationConfiguration;
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

export interface RsglWorkerFailure {
  type: "error";
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
