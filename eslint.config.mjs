import js from "@eslint/js";
import tseslint from "typescript-eslint";

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
  {
    files: ["src/**/*.ts"],
    ignores: ["src/test/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: [
            "**/rsgl-core/**",
            "**/rsgl-lsp/**",
            "**/rsgl-cli/**",
            "**/rsgl-shared/**",
            "**/vscode-rsgl/**"
          ],
          message: "The main extension may depend only on the mc-assets and resource-project internal source modules."
        }]
      }]
    }
  },
  {
    files: [
      "src/resourceUniverse/providers/rsglGeneratedProvider.ts",
      "src/resourceUniverse/providers/rsglGeneratedSnapshotMapper.ts",
      "src/rsgl/rsglResourceNavigationBridge.ts",
      "src/rsgl/rsglGeneratedContributionBridge.ts",
      "src/rsgl/runtime/loadInstalledRsglRuntime.ts"
    ],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: [
            "**/rsgl-core/**",
            "**/rsgl-lsp/**",
            "**/rsgl-cli/**",
            "**/vscode-rsgl/**"
          ],
          message: "The generated-resource protocol adapter may consume rsgl-shared DTOs, but not compiler or host layers."
        }]
      }]
    }
  },
  {
    files: ["packages/resource-project/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["vscode", "**/mc-assets/**", "**/rsgl-*/**", "**/vscode-rsgl/**", "../../../src/**", "../../../../src/**"],
          message: "resource-project must remain URI-neutral and independent from editor and compiler hosts."
        }]
      }]
    }
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
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["vscode"],
          message: "Pure project/universe orchestration must use an injected host boundary."
        }]
      }]
    }
  },
  {
    files: ["packages/mc-assets/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/rsgl-*/**", "**/vscode-rsgl/**", "../../../src/**", "../../../../src/**"],
          message: "mc-assets is the lowest internal source-module layer."
        }]
      }]
    }
  },
  {
    files: ["packages/rsgl-core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: [
            "**/rsgl-lsp/**",
            "**/rsgl-cli/**",
            "**/rsgl-shared/**",
            "**/vscode-rsgl/**",
            "../../../src/**",
            "../../../../src/**"
          ],
          message: "rsgl-core may depend on mc-assets, but not on hosts or higher RSGL layers."
        }]
      }]
    }
  },
  {
    files: ["packages/rsgl-shared/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/mc-assets/**", "**/rsgl-*/**", "**/vscode-rsgl/**", "../../../src/**"],
          message: "rsgl-shared must remain a dependency-free constants layer."
        }]
      }]
    }
  },
  {
    files: ["packages/rsgl-lsp/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/rsgl-cli/**", "**/vscode-rsgl/**", "../../../src/**"],
          message: "The LSP must not depend on CLI or VS Code integration layers."
        }]
      }]
    }
  },
  {
    files: ["packages/rsgl-cli/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/rsgl-lsp/**", "**/rsgl-shared/**", "**/vscode-rsgl/**", "../../../src/**"],
          message: "The CLI distribution may consume rsgl-core but not editor integration layers."
        }]
      }]
    }
  },
  {
    files: ["src/rsgl/host/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/rsgl-lsp/**", "**/rsgl-cli/**", "../../../src/**", "../../../../src/**"],
          message: "The lazy RSGL host may consume core/shared modules but not the LSP, CLI, or root host."
        }]
      }]
    }
  }
);
