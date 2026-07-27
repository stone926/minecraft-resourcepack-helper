import type { RsglResourceValidationOptions } from "./compiler";
import {
  projectCompileOptionsFromRsglConfig,
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
 * `defaultAssetsPath` and `resourcePackRoots` fall back to the validated
 * config when a host does not resolve its own values.
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
      defaultAssetsPath: config.defaultAssetsPath,
      resourcePackRoots: config.resourcePackRoots,
      ...overrides
    })
  };
}
