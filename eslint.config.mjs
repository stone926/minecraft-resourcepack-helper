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
          message: "The main extension may depend only on the mc-assets internal source module."
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
    files: ["extensions/vscode-rsgl/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/rsgl-cli/**", "../../../src/**", "../../../../src/**"],
          message: "The RSGL extension must not depend on the main extension or CLI host."
        }]
      }]
    }
  }
);
