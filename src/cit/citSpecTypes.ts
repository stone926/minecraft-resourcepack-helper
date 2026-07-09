export type CitType = "item" | "armor" | "elytra" | "enchantment";
export type CitSpecScope = "cit" | "global";
export type CitAssetKind = "texture" | "model";
export type CitResourceKind = "item" | "enchantment";
export type CitRuntimeStatus = "supported" | "legacy";
export type CitValueType =
  | "asset"
  | "blendFunc"
  | "boolean"
  | "enum"
  | "integer"
  | "nbtMatch"
  | "nonNegativeNumber"
  | "number"
  | "positiveInteger"
  | "positiveNumber"
  | "range"
  | "rangeList"
  | "resourceList"
  | "string";

export interface CitSpecKey {
  valueType: CitValueType;
  scope: CitSpecScope[];
  appliesTo?: Array<CitType | "base">;
  enum?: string[];
  aliases?: string[];
  default?: string;
  singleton?: boolean;
  repeatable?: boolean;
  title: string;
  description: string;
  separator?: "space";
  assetKind?: CitAssetKind;
  resourceKind?: CitResourceKind;
  patternKey?: string;
  completion?: string;
  citResewnOnly?: boolean;
  minimum?: number;
  maximum?: number;
  allowPercent?: boolean;
  runtimeStatus?: CitRuntimeStatus;
  runtimeNote?: string;
}

export interface CitSpecRule {
  id: string;
  type: string;
  when?: Record<string, unknown>;
  keys?: string[];
  or?: string[];
}

export interface CitSpecFragment {
  version: 1;
  id: string;
  scope: CitSpecScope;
  keys: Record<string, CitSpecKey>;
  patterns: Record<string, CitSpecKey>;
  rules: CitSpecRule[];
}

export interface ResolvedCitSpecKey extends CitSpecKey {
  key: string;
  pattern?: string;
  canonicalKey?: string;
}

export interface ResolvedCitSpec {
  scope: CitSpecScope;
  citType?: CitType;
  keys: Map<string, ResolvedCitSpecKey>;
  patterns: ResolvedCitSpecKey[];
  rules: CitSpecRule[];
  fragments: string[];
}

export interface CitSpecLookupResult {
  spec: ResolvedCitSpecKey;
  matchedBy: "key" | "alias" | "pattern";
}
