import type { RsglExternDeclaration } from "../externDeclarations";
import type {
  RsglExternalResourceResolution,
  RsglResourceExistenceKind,
  RsglResourceValidationOptions
} from "./validationTypes";

export type RsglExternDeclarationSelection =
  | {
      readonly kind: "selected";
      readonly declaration: RsglExternDeclaration;
      /** Best matching declaration from every explicitly allowed physical source. */
      readonly declarations: readonly RsglExternDeclaration[];
    }
  | { readonly kind: "unsupported" }
  | { readonly kind: "undeclared" };

interface ResourceValidationPassCache {
  readonly externDeclarationSelections: Map<string, RsglExternDeclarationSelection>;
}

type ResourceValidationPassOverrides = Partial<
  Pick<RsglResourceValidationOptions, "generatedResourceIds" | "targetPackFormat">
>;

const validationPassCaches = new WeakMap<RsglResourceValidationOptions, ResourceValidationPassCache>();

/**
 * Creates options whose memoized state is owned by exactly one validation
 * pass. Hosts are queried again when the next pass creates a fresh wrapper.
 */
export function createResourceValidationPassOptions(
  options: RsglResourceValidationOptions,
  overrides: ResourceValidationPassOverrides = {}
): RsglResourceValidationOptions {
  const resolveResource = options.resourceResolution;
  const resolveExternalResource = options.externResourceResolution;
  const resourceResolutions = resolveResource || resolveExternalResource
    ? new Map<string, RsglExternalResourceResolution>()
    : undefined;
  const passOptions: RsglResourceValidationOptions = {
    ...options,
    ...overrides,
    ...(resolveResource
      ? {
          resourceResolution: (
            kind,
            id
          ): RsglExternalResourceResolution => cachedResourceResolution(
            resourceResolutions!,
            "effective",
            kind,
            id,
            () => resolveResource(kind, id)
          )
        }
      : {}),
    ...(resolveExternalResource
      ? {
          externResourceResolution: (
            source,
            kind,
            id
          ): RsglExternalResourceResolution => cachedResourceResolution(
            resourceResolutions!,
            source,
            kind,
            id,
            () => resolveExternalResource(source, kind, id)
          )
        }
      : {})
  };
  validationPassCaches.set(passOptions, {
    externDeclarationSelections: new Map()
  });
  return passOptions;
}

export function cachedExternDeclarationSelection(
  options: RsglResourceValidationOptions,
  kind: RsglResourceExistenceKind,
  id: string,
  normalizedScopeFile: string,
  select: () => RsglExternDeclarationSelection
): RsglExternDeclarationSelection {
  const cache = validationPassCaches.get(options)?.externDeclarationSelections;
  if (!cache) {
    return select();
  }
  const key = [kind, id, normalizedScopeFile].join("\0");
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const selection = select();
  cache.set(key, selection);
  return selection;
}

function cachedResourceResolution(
  cache: Map<string, RsglExternalResourceResolution>,
  source: string,
  kind: RsglResourceExistenceKind,
  id: string,
  resolve: () => RsglExternalResourceResolution
): RsglExternalResourceResolution {
  const key = [source, kind, id].join("\0");
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = resolve();
  cache.set(key, resolved);
  return resolved;
}
