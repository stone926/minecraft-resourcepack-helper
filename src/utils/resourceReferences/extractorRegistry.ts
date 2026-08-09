import { ScopedRegistry, type ScopedRegistration } from "../scopedRegistry";
import type { ResourceReference, ResourceReferenceDocument } from "./types";

export type RegisteredResourceReferenceExtractor = (
  document: ResourceReferenceDocument
) => ResourceReference[];

const extractors = new ScopedRegistry<string, RegisteredResourceReferenceExtractor>();
let extractionGeneration = 0;

export function registerResourceReferenceExtractor(
  id: string,
  extractor: RegisteredResourceReferenceExtractor
): ScopedRegistration {
  const registration = extractors.register(id, extractor);
  extractionGeneration++;
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      registration.dispose();
      extractionGeneration++;
    }
  };
}

export function getRegisteredResourceReferenceExtractor(
  id: string
): RegisteredResourceReferenceExtractor | undefined {
  return extractors.get(id);
}

export function getResourceReferenceExtractionGeneration(): number {
  return extractionGeneration;
}
