import type * as vscode from "vscode";
import { resourceUriKey } from "./resourceGraphSearch";
import type {
  ResourceReference,
  ResourceReferenceDocument
} from "./resourceReferences";

export interface ResourceGraphDocument extends ResourceReferenceDocument {
  uri: vscode.Uri;
}

export interface ResolvedResourceReference {
  reference: ResourceReference;
  sourceUri: vscode.Uri;
  targetUri: vscode.Uri | null;
}

export interface ResourceReferenceSourceGroup {
  sourceUri: vscode.Uri;
  references: ResolvedResourceReference[];
}

export type ResourceGraphPathChangeKind = "create" | "change" | "delete";

export function groupReferencesBySource(
  references: ResolvedResourceReference[]
): ResourceReferenceSourceGroup[] {
  const groups = new Map<string, ResourceReferenceSourceGroup>();
  for (const reference of references) {
    const key = resourceUriKey(reference.sourceUri);
    const group = groups.get(key);
    if (group) {
      group.references.push(reference);
    } else {
      groups.set(key, { sourceUri: reference.sourceUri, references: [reference] });
    }
  }
  return [...groups.values()];
}
