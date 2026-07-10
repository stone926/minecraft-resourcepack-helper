import { JsonValue, RsglMapping } from "./ir";

/** A typed blockstate template fragment before it enters the shared merge engine. */
export interface RsglBlockstateFragment {
  content: Record<string, JsonValue>;
  mappings?: RsglMapping[];
}
