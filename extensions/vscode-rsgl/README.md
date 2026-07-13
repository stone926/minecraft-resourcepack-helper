# RSGL - Resourcepack Generation Language

Standalone VS Code extension for editing and building RSGL resource pack source files.

## Features

- Language registration and syntax highlighting for `.rsgl` files.
- Completion, diagnostics, hover, and formatting powered by the bundled RSGL language server.
- Build and preview commands for a single file, a source directory, or workspace source roots.

This extension can be installed directly, and is also installed automatically when Minecraft Resourcepack Helper is installed.

## Project configuration

Place `rsgl.config.json` in a project directory or one of its ancestors. The extension provides validation and completion for every supported setting. A typical configuration is:

```json
{
  "root": "src",
  "outDir": ".generated",
  "namespace": "example",
  "target": {
    "edition": "java",
    "mc": "1.21.4"
  },
  "maxEvaluationItems": 100000
}
```

`namespace` is a project default, not a hard override. The effective namespace is selected in this order: an explicit compiler or API override, a `namespace` declaration in the RSGL file, the project `namespace`, then `minecraft`.

`target` is a project-wide constraint. Set exactly one of `format` (for example `[50, 0]`) or `mc` (for example `"1.21.4"`) with `edition: "java"`. A matching source-level target declaration is allowed; a conflicting declaration is reported instead of replacing the project target.

`maxEvaluationItems` is the positive project budget for bounded compile-time collection expansion and defaults to `100000`. It is part of the effective compiler configuration and cache identity; collection operations consume the budget when that language surface is used.
