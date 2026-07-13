import type { RsglResourceKind } from "./resourceKinds";

export interface RsglResourceBodyHelperDescriptor {
  name: string;
  resourceKind: Exclude<RsglResourceKind, "blockstate">;
}

export const rsglResourceBodyHelperDescriptors = [
  { name: "atlasDirectory", resourceKind: "atlas" },
  { name: "particlesSeq", resourceKind: "particles" },
  { name: "mcmetaAnimation", resourceKind: "mcmeta" },
  { name: "nineSliceGui", resourceKind: "mcmeta" },
  { name: "equipmentLayers", resourceKind: "equipment" }
] as const satisfies readonly RsglResourceBodyHelperDescriptor[];

const descriptorsByName = new Map<string, RsglResourceBodyHelperDescriptor>(
  rsglResourceBodyHelperDescriptors.map(descriptor => [descriptor.name, descriptor])
);

export function getRsglResourceBodyHelperDescriptor(name: string): RsglResourceBodyHelperDescriptor | undefined {
  return descriptorsByName.get(name);
}
