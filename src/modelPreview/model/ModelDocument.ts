import type { PreviewTransform, PreviewVec3 } from "../ir/PreviewDocument";

export interface ModelPreviewConfiguration {
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
}

export interface ModelPreviewFileSystem {
  readTextFile(fileName: string): Promise<string>;
  fileExists(fileName: string): boolean;
}

export interface RawModelDocument {
  fileName: string;
  text: string;
  data: RawModelData | null;
}

export interface RawModelData {
  parent?: string;
  textures?: Record<string, RawTextureValue>;
  elements?: RawElement[];
  display?: Record<string, Partial<PreviewTransform>>;
}

export type RawTextureValue = string | RawTextureObject;

export interface RawTextureObject {
  sprite?: string;
  force_translucent?: boolean;
}

export interface RawElement {
  from?: PreviewVec3;
  to?: PreviewVec3;
  rotation?: RawElementRotation;
  shade?: boolean;
  light_emission?: number;
  faces?: Partial<Record<RawFaceName, RawFace>>;
}

export interface RawElementRotation {
  origin?: PreviewVec3;
  axis?: "x" | "y" | "z";
  angle?: number;
  x?: number;
  y?: number;
  z?: number;
  rescale?: boolean;
}

export interface RawFace {
  uv?: [number, number, number, number];
  texture?: string;
  rotation?: number;
  cullface?: string;
  tintindex?: number;
}

export type RawFaceName = "down" | "up" | "north" | "south" | "west" | "east";

export interface ResolvedModel {
  fileName: string;
  resourceId: string;
  parent?: string;
  generatedItem: boolean;
  textures: Record<string, ResolvedTextureSlot>;
  elements: ResolvedElement[];
  display: Record<string, PreviewTransform>;
  dependencies: ResolvedDependency[];
}

export interface ResolvedTextureSlot {
  name: string;
  value: RawTextureValue;
  sourceModelFileName: string;
}

export interface ResolvedElement {
  element: RawElement;
  index: number;
  sourceModelFileName: string;
}

export interface ResolvedDependency {
  fileName: string;
  kind: "model" | "texture" | "textureMetadata";
}

export function isTextureObject(value: RawTextureValue): value is RawTextureObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
