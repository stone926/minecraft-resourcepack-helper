import {
  getResourceGraphPreviewContext,
  type ResourceGraphPreviewContext
} from "../resources/resourceSurfaceRegistry";

export type { ResourceGraphPreviewContext } from "../resources/resourceSurfaceRegistry";

export function classifyResourceGraphPreview(fileName: string): ResourceGraphPreviewContext | undefined {
  return getResourceGraphPreviewContext(fileName);
}
