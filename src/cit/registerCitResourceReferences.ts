import { registerResourceReferenceExtractor } from "../utils/resourceReferences";
import type { ScopedRegistration } from "../utils/scopedRegistry";
import { getCitPropertyReferences } from "./citProperties";

export function registerCitResourceReferenceExtractor(): ScopedRegistration {
  return registerResourceReferenceExtractor(
    "citProperties",
    document => getCitPropertyReferences(document)
  );
}
