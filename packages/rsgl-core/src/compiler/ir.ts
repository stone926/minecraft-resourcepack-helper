import { TextRange } from "../parser";
import type { ExternResourceKind, RsglResourceKind } from "../resourceKinds";
import type { ExternResourceSource } from "../externDeclarations";
import type { CompileDependency } from "./base/types";
import type { RsglResourceValueObservation } from "./evaluatedResourceValues";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface TextValue {
  kind: "text";
  text: string;
}

export interface BinaryCopyRef {
  kind: "copy";
  sourcePath: string;
}

export type ExternalResourceKind = ExternResourceKind;

export interface ExternalResourceRef {
  kind: "external";
  resourceKind: ExternalResourceKind;
  id: string;
  source: ExternResourceSource;
  skipExistenceCheck: boolean;
}

export type ResourceContent = JsonValue | TextValue | BinaryCopyRef;

export interface ResourceId {
  namespace: string;
  path: string;
}

export type ResourceKind = RsglResourceKind | ExternalResourceKind;

export interface ResourceUnit {
  id?: ResourceId;
  kind: ResourceKind;
  outputPath: string;
  content: ResourceContent;
  external?: ExternalResourceRef;
  /** Compile-only metadata consumed by validators and never emitted. */
  validation?: {
    externalTextureVariables?: string[];
    referenceOrigins?: RsglValidationReferenceOrigin[];
    resourceValueObservations?: RsglResourceValueObservation[];
  };
  mergePolicy: MergePolicy;
  sourceMap: RsglSourceMap;
}

export type MergePolicy =
  | { kind: "replace" }
  | { kind: "errorOnConflict" }
  | { kind: "mergeObject" }
  | { kind: "appendArray" };

export interface RsglSourceMap {
  generatedFile: string;
  mappings: RsglMapping[];
}

export interface RsglMapping {
  generatedPath: string;
  sourceFile: string;
  sourceRange: TextRange;
  reason: "direct" | "template" | "loop" | "builtin" | "base";
  expansionStack: ExpansionFrame[];
  /** Internal lexical origin for extern validation; removed before results are exposed. */
  validationOrigin?: Omit<RsglValidationReferenceOrigin, "generatedPath">;
  /** Internal mapping that exists only to carry validationOrigin metadata. */
  validationOnly?: boolean;
}

export interface RsglValidationReferenceOrigin {
  generatedPath: string;
  sourceFile: string;
  sourceRange: TextRange;
}

export interface ExpansionFrame {
  label: string;
  /** Caller file for cross-module expansion frames. */
  sourceFile?: string;
  sourceRange?: TextRange;
}

export interface RsglCompileResult {
  units: ResourceUnit[];
  diagnostics: RsglCompileDiagnostic[];
  dependencies: CompileDependency[];
}

export interface RsglCompileDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  range: TextRange;
  fileName?: string;
}

export function isExternalResourceUnit(unit: ResourceUnit): boolean {
  return unit.external?.kind === "external";
}
