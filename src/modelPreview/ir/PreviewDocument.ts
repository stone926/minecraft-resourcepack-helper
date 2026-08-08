import type { LocalizedMessage } from "../../i18n/messages";

export type PreviewVec2 = [number, number];
export type PreviewVec3 = [number, number, number];

export type PreviewDirection = "down" | "up" | "north" | "south" | "west" | "east";

export interface ModelPreviewDocument {
  version: 1;
  sourceUri: string;
  resourceId: string;
  title: string;
  bounds: PreviewBounds;
  meshes: PreviewMesh[];
  materials: PreviewMaterial[];
  display: Record<string, PreviewTransform>;
  dependencies: PreviewDependency[];
  issues: PreviewIssue[];
}

export interface PreviewBounds {
  min: PreviewVec3;
  max: PreviewVec3;
}

export interface PreviewTransform {
  rotation: PreviewVec3;
  translation: PreviewVec3;
  scale: PreviewVec3;
}

export interface PreviewMesh {
  id: string;
  elementIndex: number;
  sourceModelUri: string;
  faces: PreviewFace[];
}

export interface PreviewFace {
  direction: PreviewDirection;
  positions: PreviewVec3[];
  uvs: PreviewVec2[];
  materialId: string;
  cullface?: string;
  tintindex?: number;
  shade: boolean;
  lightEmission: number;
}

export interface PreviewMaterial {
  id: string;
  textureUri?: string;
  textureVersion?: string | null;
  fallback: "texture" | "missing" | "solid";
  transparent: boolean;
}

export interface PreviewDependency {
  uri: string;
  kind: "model" | "texture" | "textureMetadata" | "packMetadata" | "configuration";
  /** Internal resolution candidate that must be watched but is not an effective preview input. */
  watchOnly?: boolean;
}

export interface PreviewPosition {
  line: number;
  character: number;
}

export interface PreviewRange {
  start: PreviewPosition;
  end: PreviewPosition;
}

export interface PreviewIssue {
  severity: "error" | "warning" | "info";
  message: LocalizedMessage;
  resourceUri?: string;
  range?: PreviewRange;
}

export interface WebviewModelPreviewDocument extends Omit<ModelPreviewDocument, "issues"> {
  issues: WebviewPreviewIssue[];
}

export interface WebviewPreviewIssue extends Omit<PreviewIssue, "message"> {
  message: string;
}

export function emptyBounds(): PreviewBounds {
  return {
    min: [0, 0, 0],
    max: [0, 0, 0]
  };
}
