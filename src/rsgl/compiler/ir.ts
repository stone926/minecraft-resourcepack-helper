import { TextRange } from "../parser";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ResourceId {
  namespace: string;
  path: string;
}

export type ResourceKind =
  | "blockstate"
  | "model"
  | "item"
  | "atlas"
  | "mcmeta"
  | "particles"
  | "equipment"
  | "font"
  | "pack"
  | "lang"
  | "sounds"
  | "raw";

export interface ResourceUnit {
  id?: ResourceId;
  kind: ResourceKind;
  outputPath: string;
  content: JsonValue;
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
  reason: "direct" | "template" | "loop" | "builtin";
  expansionStack: ExpansionFrame[];
}

export interface ExpansionFrame {
  label: string;
  sourceRange?: TextRange;
}

export interface RsglCompileResult {
  units: ResourceUnit[];
  diagnostics: RsglCompileDiagnostic[];
}

export interface RsglCompileDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  range: TextRange;
  fileName?: string;
}
