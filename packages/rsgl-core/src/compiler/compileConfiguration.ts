import type { RsglNormalizedProjectTarget } from "./targetConfig";

export const DEFAULT_MAX_EVALUATION_ITEMS = 100_000;

/** Internal compiler configuration. `namespace` remains the hard API override. */
export interface RsglCompileConfigurationOptions {
  namespace?: string;
  defaultNamespace?: string;
  projectTarget?: RsglNormalizedProjectTarget;
  maxEvaluationItems?: number;
}

/** Fully materialized compiler configuration shared by all pipeline stages. */
export interface ResolvedRsglCompileConfiguration {
  namespaceOverride?: string;
  defaultNamespace: string;
  projectTarget?: RsglNormalizedProjectTarget;
  maxEvaluationItems: number;
  semanticFingerprint: string;
}

/** Resolves defaults once and creates the stable semantic cache identity. */
export function resolveRsglCompileConfiguration(
  options: RsglCompileConfigurationOptions = {}
): ResolvedRsglCompileConfiguration {
  const namespaceOverride = options.namespace;
  const defaultNamespace = options.defaultNamespace ?? "minecraft";
  const projectTarget = cloneProjectTarget(options.projectTarget);
  const maxEvaluationItems = options.maxEvaluationItems ?? DEFAULT_MAX_EVALUATION_ITEMS;
  const semanticFingerprint = createRsglSemanticConfigurationFingerprint({
    namespaceOverride,
    defaultNamespace,
    projectTarget,
    maxEvaluationItems
  });
  return {
    ...(namespaceOverride === undefined ? {} : { namespaceOverride }),
    defaultNamespace,
    ...(projectTarget === undefined ? {} : { projectTarget }),
    maxEvaluationItems,
    semanticFingerprint
  };
}

/**
 * The only namespace-precedence helper used by compiler stages.
 * hard API override > file declaration > project default > minecraft
 */
export function effectiveNamespace(
  declaredNamespace: string | undefined,
  configuration: Pick<ResolvedRsglCompileConfiguration, "namespaceOverride" | "defaultNamespace">
): string {
  return configuration.namespaceOverride ?? declaredNamespace ?? configuration.defaultNamespace;
}

/** Creates a versioned, property-order-independent fingerprint of semantic inputs. */
export function createRsglSemanticConfigurationFingerprint(
  configuration: Pick<
    ResolvedRsglCompileConfiguration,
    "namespaceOverride" | "defaultNamespace" | "projectTarget" | "maxEvaluationItems"
  >
): string {
  const target = configuration.projectTarget?.packFormat;
  return `rsgl-semantic-config-v1:${JSON.stringify([
    configuration.namespaceOverride ?? null,
    configuration.defaultNamespace,
    target ? [target.major, target.minor] : null,
    configuration.maxEvaluationItems
  ])}`;
}

function cloneProjectTarget(
  target: RsglNormalizedProjectTarget | undefined
): RsglNormalizedProjectTarget | undefined {
  return target
    ? {
      edition: "java",
      packFormat: { ...target.packFormat }
    }
    : undefined;
}
