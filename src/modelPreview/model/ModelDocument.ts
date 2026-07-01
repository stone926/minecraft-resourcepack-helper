import type { PreviewRange, PreviewTransform, PreviewVec3 } from "../ir/PreviewDocument";
import type { ModelJsonLocations } from "./ModelJsonLocations";
import type { PackMetadata } from "../../utils/resourceLocation";

export interface ModelPreviewConfiguration {
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
}

export interface ModelPreviewFileSystem {
  readTextFile(fileName: string): Promise<string>;
  readBinaryFile(fileName: string): Promise<Uint8Array>;
  fileExists(fileName: string): boolean;
  fileVersion?(fileName: string): string | null;
  getPackRoot?(fileName: string): string | null;
  getPackMetadata?(packRoot: string): PackMetadata;
}

export interface RawModelDocument {
  fileName: string;
  text: string;
  data: RawModelData | null;
  locations?: ModelJsonLocations;
}

export interface RawModelData {
  parent?: string;
  parentRange?: PreviewRange;
  textures?: Record<string, RawTextureValue>;
  textureRanges?: Record<string, PreviewRange>;
  elements?: RawElement[];
  display?: Record<string, Partial<PreviewTransform>>;
}

export type RawTextureValue = string | RawTextureObject;

export interface RawTextureObject {
  sprite?: string;
  forceTranslucent?: boolean;
}

export interface RawElement {
  from?: PreviewVec3;
  fromRange?: PreviewRange;
  to?: PreviewVec3;
  toRange?: PreviewRange;
  range?: PreviewRange;
  rotation?: RawElementRotation;
  shade?: boolean;
  lightEmission?: number;
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
  rescaleRange?: PreviewRange;
}

export interface RawFace {
  range?: PreviewRange;
  uv?: [number, number, number, number];
  uvRange?: PreviewRange;
  texture?: string;
  textureRange?: PreviewRange;
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
  valueRange?: PreviewRange;
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
