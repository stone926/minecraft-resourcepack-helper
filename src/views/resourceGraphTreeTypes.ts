import type { ResourceGraphLogicalKey } from "../../packages/mc-assets/src";
import type {
  ResourceLocation,
  ResourceMaterializationState,
  ResourceProducer
} from "../resourceUniverse";
import type { ResourceReference, ResourceReferenceDocument } from "../utils/resourceReferences/types";

export type ResourceGraphCollapsibleState = "none" | "collapsed" | "expanded";

export interface ResourceGraphUriLike {
  readonly scheme: string;
  readonly fsPath: string;
  toString(): string;
}

export interface ResourceGraphTreeDocument extends ResourceReferenceDocument {
  readonly uri: ResourceGraphUriLike;
}

export interface ResourceGraphProjectedResource {
  readonly target: ResourceGraphLogicalKey;
  readonly producer: ResourceProducer;
  readonly candidates?: readonly ResourceProducer[];
  readonly resolutionStatus?: "resolved" | "multiple" | "missing" | "incomplete" | "conflict";
}

export interface ResourceGraphTreeResolvedReference {
  readonly reference: ResourceReference;
  readonly sourceUri: ResourceGraphUriLike;
  readonly targetUri: ResourceGraphUriLike | null;
  readonly target?: ResourceGraphLogicalKey;
  readonly sourceRange?: ResourceLocation["range"];
  readonly sourceResource?: ResourceGraphProjectedResource;
  readonly targetResource?: ResourceGraphProjectedResource;
}

export interface ResourceGraphDocumentProjection {
  readonly applicable: boolean;
  readonly providerIds: readonly string[];
  readonly coverage: "authoritative" | "partial" | "unavailable";
  readonly resources: readonly ResourceGraphProjectedResource[];
  readonly contributesTo: readonly ResourceGraphProjectedResource[];
}

export type ResourceGraphBlockInventory =
  | {
      status: "authoritative";
      uris: readonly ResourceGraphUriLike[];
      resources?: readonly ResourceGraphProjectedResource[];
    }
  | {
      status: "partial";
      uris: readonly ResourceGraphUriLike[];
      resources?: readonly ResourceGraphProjectedResource[];
      reason?: string;
    }
  | { status: "unknown"; reason?: string };

export type ResourceGraphNodeNavigation =
  | {
      kind: "producer";
      producerId: string;
      target: ResourceGraphLogicalKey;
      preferMaterialized?: boolean;
    }
  | { kind: "resourceUri"; uri: ResourceGraphUriLike }
  | { kind: "location"; location: ResourceLocation };

export interface ResourceGraphTreeNodeModel {
  readonly label: string;
  readonly collapsibleState: ResourceGraphCollapsibleState;
  readonly description?: string;
  /** Set only when a physical URI is safe for existing preview commands. */
  readonly resourceUri?: ResourceGraphUriLike;
  readonly navigation?: ResourceGraphNodeNavigation;
  readonly resource?: ResourceGraphProjectedResource;
  readonly materializationState?: ResourceMaterializationState;
  readonly icon: string;
  readonly contextValue?: string;
  readonly tooltip?: string;
  getChildren(): Promise<ResourceGraphTreeNodeModel[]>;
}

export interface ResourceGraphTreeModelHost {
  getDocumentProjection(document: ResourceGraphTreeDocument): Promise<ResourceGraphDocumentProjection>;
  getBlockstateInventory(): Promise<ResourceGraphBlockInventory>;
  getReferences(document: ResourceGraphTreeDocument): Promise<readonly ResourceGraphTreeResolvedReference[]>;
  getIncomingReferences(uri: ResourceGraphUriLike): Promise<readonly ResourceGraphTreeResolvedReference[]>;
  getChildModelReferences(uri: ResourceGraphUriLike): Promise<readonly ResourceGraphTreeResolvedReference[]>;
  getProducerReferences(resource: ResourceGraphProjectedResource): Promise<readonly ResourceGraphTreeResolvedReference[]>;
  getProducerIncomingReferences(resource: ResourceGraphProjectedResource): Promise<readonly ResourceGraphTreeResolvedReference[]>;
  getProducerChildModelReferences(resource: ResourceGraphProjectedResource): Promise<readonly ResourceGraphTreeResolvedReference[]>;
  loadDocument(uri: ResourceGraphUriLike): Promise<ResourceGraphTreeDocument>;
}

export type ResourceGraphLocalize = (message: string, ...args: Array<string | number>) => string;
