import type { MinecraftResourceId } from "./resourceId";

export interface MinecraftResourceTarget {
  directory: string;
  extension: string | null;
  isDirectory: boolean;
}

const directoryByKind: Record<string, string> = {
  model: "models",
  blockstate: "blockstates",
  item: "items",
  texture: "textures",
  textureDirectory: "textures",
  fontFile: "font",
  shaderVertex: "shaders",
  shaderFragment: "shaders",
  sound: "sounds",
  atlas: "atlases"
};

const targetByKind: Record<string, Omit<MinecraftResourceTarget, "directory">> = {
  texture: { extension: "png", isDirectory: false },
  textureDirectory: { extension: null, isDirectory: true },
  fontFile: { extension: null, isDirectory: false },
  shaderVertex: { extension: "vsh", isDirectory: false },
  shaderFragment: { extension: "fsh", isDirectory: false },
  sound: { extension: "ogg", isDirectory: false }
};

export function minecraftResourceDirectory(kind: string): string {
  return directoryByKind[kind] ?? kind;
}

export function minecraftResourceTarget(kind: string): MinecraftResourceTarget {
  const target = targetByKind[kind] ?? { extension: "json", isDirectory: false };
  return { directory: minecraftResourceDirectory(kind), ...target };
}

export function minecraftResourceOutputPath(kind: string, id: MinecraftResourceId, extension = "json"): string {
  return `assets/${id.namespace}/${minecraftResourceDirectory(kind)}/${id.path}.${extension}`;
}
