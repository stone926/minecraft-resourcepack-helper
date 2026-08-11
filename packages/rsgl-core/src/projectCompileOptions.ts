import type { RsglResourceValidationOptions } from "./compiler";
import {
  projectCustomResourcePackPaths,
  projectCompileOptionsFromRsglConfig,
  projectVanillaResourcePackPath,
  type RsglProjectCompileOptions,
  type RsglProjectConfig
} from "./rsglConfig";
import {
  createRsglWorkspaceValidationOptions,
  type RsglWorkspaceValidationCallbacks,
  type RsglWorkspaceValidationOptions
} from "./workspaceValidation";

/**
 * Host-specific workspace facts layered over the project-config defaults.
 * Internal `defaultAssetsPath` and `resourcePackRoots` values fall back to
 * the canonical project-config resource-pack paths when a host does not
 * resolve its own values.
 */
export type RsglProjectWorkspaceOverrides = Pick<RsglWorkspaceValidationOptions, "sourceFileName">
  & Partial<Pick<
    RsglWorkspaceValidationOptions,
    "outputPackRoot" | "defaultAssetsPath" | "resourcePackRoots" | "cache"
  >>;

export type RsglProjectDerivedCompileOptions = RsglProjectCompileOptions
  & Pick<RsglResourceValidationOptions, "globalExterns" | "checkExternExistence">
  & RsglWorkspaceValidationCallbacks;

/**
 * Builds the compile options every host derives from a validated project
 * config: config-mapped compile options, global extern declarations, and
 * workspace resource-resolution callbacks. Hosts add only their own extras
 * on top (emit and materialization options for the CLI; stdlibRoot and
 * targetPackFormat for the LSP).
 */
export function compileOptionsFromProjectConfig(
  config: RsglProjectConfig,
  overrides: RsglProjectWorkspaceOverrides
): RsglProjectDerivedCompileOptions {
  return {
    ...projectCompileOptionsFromRsglConfig(config),
    globalExterns: config.extern,
    checkExternExistence: config.checkExternExistence,
    ...createRsglWorkspaceValidationOptions({
      defaultAssetsPath: projectVanillaResourcePackPath(config),
      resourcePackRoots: projectCustomResourcePackPaths(config),
      ...overrides
    })
  };
}
