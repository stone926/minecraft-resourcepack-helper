import type { RsglGlobalExternConfigEntry } from "../../../packages/rsgl-core/src/externDeclarations";

export interface RsglValidationConfiguration {
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
  globalExterns?: RsglGlobalExternConfigEntry[];
  checkExternExistence?: boolean;
}

/** Applies explicit API values over project defaults without treating null as absent. */
export function mergeRsglValidationConfiguration(
  overrides: RsglValidationConfiguration,
  fallback: RsglValidationConfiguration
): RsglValidationConfiguration {
  return {
    defaultAssetsPath: overrides.defaultAssetsPath === undefined
      ? fallback.defaultAssetsPath
      : overrides.defaultAssetsPath,
    resourcePackRoots: overrides.resourcePackRoots === undefined
      ? fallback.resourcePackRoots
      : overrides.resourcePackRoots,
    globalExterns: overrides.globalExterns === undefined
      ? fallback.globalExterns
      : overrides.globalExterns,
    checkExternExistence: overrides.checkExternExistence === undefined
      ? fallback.checkExternExistence
      : overrides.checkExternExistence
  };
}
