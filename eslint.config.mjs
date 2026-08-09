import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Uniform parent-directory escapes back into root `src`, for every nesting depth in use. */
const parentSrcEscapes = ["../../../src/**", "../../../../src/**", "../../../../../src/**"];

/**
 * Layer boundaries, one row per source area. Each row generates a
 * `no-restricted-imports` block; edit the table, not the generated blocks.
 */
const layerBoundaries = [
  {
    files: ["packages/shared-utils/src/**/*.ts"],
    forbidden: ["vscode", "**/mc-assets/**", "**/resource-project/**", "**/rsgl-*/**", ...parentSrcEscapes],
    message: "shared-utils must remain dependency-free and usable by every bundle."
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/test/**/*.ts"],
    forbidden: [
      "**/rsgl-core/**",
      "**/rsgl-lsp/**",
      "**/rsgl-cli/**",
      "**/rsgl-shared/**",
      "**/vscode-rsgl/**"
    ],
    message: "The main extension may depend only on shared-utils, mc-assets, and resource-project internal source modules."
  },
  {
    files: ["src/utils/**/*.ts"],
    forbidden: ["**/services/**", "**/cit/**"],
    message: "Utility modules must stay below stateful services and feature-owned CIT adapters."
  },
  {
    files: [
      "src/rsgl/provider/rsglGeneratedProvider.ts",
      "src/rsgl/provider/rsglGeneratedSnapshotMapper.ts",
      "src/rsgl/rsglResourceNavigationBridge.ts",
      "src/rsgl/rsglGeneratedContributionBridge.ts",
      "src/rsgl/runtime/loadInstalledRsglRuntime.ts"
    ],
    forbidden: ["**/rsgl-core/**", "**/rsgl-lsp/**", "**/rsgl-cli/**", "**/vscode-rsgl/**"],
    message: "The generated-resource protocol adapter may consume rsgl-shared DTOs, but not compiler or host layers."
  },
  {
    files: ["packages/resource-project/src/**/*.ts"],
    forbidden: ["vscode", "**/mc-assets/**", "**/rsgl-*/**", "**/vscode-rsgl/**", ...parentSrcEscapes],
    message: "resource-project must remain URI-neutral and independent from editor and compiler hosts."
  },
  {
    files: [
      "src/resourceProject/index.ts",
      "src/resourceProject/resourcePackProjectService.ts",
      "src/resourceProject/resourceProjectDiscovery.ts",
      "src/resourceProject/sharedConfiguration.ts",
      "src/resourceProject/types.ts",
      "src/services/resourceProjectUniverseInvalidator.ts",
      "src/resourceUniverse/core/**/*.ts",
      "src/resourceUniverse/providers/physicalAssetProvider.ts",
      "src/resourceUniverse/providers/physicalAssetReferenceAdapter.ts",
      "src/resourceUniverse/providers/physicalAssetSnapshot.ts"
    ],
    forbidden: ["vscode"],
    message: "Pure project/universe orchestration must use an injected host boundary."
  },
  {
    files: ["packages/mc-assets/src/**/*.ts"],
    forbidden: ["**/rsgl-*/**", "**/vscode-rsgl/**", ...parentSrcEscapes],
    message: "mc-assets is the lowest internal source-module layer."
  },
  {
    files: ["packages/rsgl-core/src/**/*.ts"],
    forbidden: [
      "**/rsgl-lsp/**",
      "**/rsgl-cli/**",
      "**/rsgl-shared/**",
      "**/vscode-rsgl/**",
      ...parentSrcEscapes
    ],
    message: "rsgl-core may depend on shared-utils and mc-assets, but not on hosts or higher RSGL layers."
  },
  {
    files: ["packages/rsgl-shared/src/**/*.ts"],
    forbidden: ["**/mc-assets/**", "**/rsgl-*/**", "**/vscode-rsgl/**", ...parentSrcEscapes],
    message: "rsgl-shared may depend on shared-utils and resource-project, but not on domain or host layers."
  },
  {
    files: ["packages/rsgl-lsp/src/**/*.ts"],
    forbidden: ["**/rsgl-cli/**", "**/vscode-rsgl/**", ...parentSrcEscapes],
    message: "The LSP must not depend on CLI or VS Code integration layers."
  },
  {
    files: ["packages/rsgl-cli/src/**/*.ts"],
    forbidden: ["**/rsgl-lsp/**", "**/rsgl-shared/**", "**/vscode-rsgl/**", ...parentSrcEscapes],
    message: "The CLI distribution may consume rsgl-core but not editor integration layers."
  },
  {
    files: ["src/rsgl/host/**/*.ts"],
    forbidden: ["**/rsgl-lsp/**", "**/rsgl-cli/**", ...parentSrcEscapes],
    message: "The lazy RSGL host may consume core/shared modules but not the LSP, CLI, or root host."
  }
];

export default tseslint.config(
  {
    ignores: ["out/**", "node_modules/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module"
    },
    rules: {
      "@typescript-eslint/naming-convention": "warn",
      "curly": "warn",
      "eqeqeq": "warn",
      "no-throw-literal": "warn",
      "no-undef": "off"
    }
  },
  ...layerBoundaries.map(({ files, ignores, forbidden, message }) => ({
    files,
    ...(ignores ? { ignores } : {}),
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: forbidden, message }]
      }]
    }
  }))
);
