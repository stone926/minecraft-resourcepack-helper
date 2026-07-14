# RSGL - Resourcepack Generation Language

Standalone VS Code extension for editing, validating, migrating, and building Minecraft Java Edition resource packs from `.rsgl` source files.

## Features

- Language registration and syntax highlighting for `.rsgl` files.
- Completion, diagnostics, hover, signature help, navigation, rename, semantic highlighting, quick fixes, and formatting powered by the bundled RSGL language server.
- VS Code build and preview commands for a single file, a source directory, or configured workspace roots, plus CLI check, migration, and watch workflows.
- Explicit template output dialects, canonical blockstate syntax, structural types, typed resource IDs, compile-time collections, namespace imports, and exact model-geometry transforms.

This extension can be installed directly, and is also installed automatically when Minecraft Resourcepack Helper is installed.

## Quick start

Create `rsgl.config.json` at the project root:

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

Then create `src/main.rsgl`:

```rsgl
namespace example

type Panel = { texture: TextureId; height: Number }

let base: Panel = {
  texture: texture_id("minecraft:block/oak_planks"),
  height: 4
}
let selected: Panel = { ...base, height: 8 }
let angles = filter([...[0, 90], ...[180, 270]], angle => angle >= 0)
let modelFor: (String) -> ModelId = name => model_id(`block/${name}`)

template panel(spec: Panel) -> model {
  parent minecraft:block/block
  textures { all: spec.texture }
  element from [0, 0, 0] to [16, spec.height, 16] {
    all texture "#all"
  }
}

model block oak_panel {
  use panel(selected)
}

blockstate variants oak_panel {
  {}: modelFor("oak_panel")
}
```

Run `rsgl check` to validate without writing, `rsgl build` to emit the generated resource-pack files, or use the matching **RSGL:** commands from the Command Palette.

## Explicit template dialects

A body-fragment template declares its output dialect after `->`. This makes a template's valid statements and every `use` site unambiguous:

- `-> model` emits model-body fields and geometry.
- `-> variants` emits canonical blockstate variant entries.
- `-> multipart` emits canonical blockstate multipart entries.

A template without an arrow remains a complete-resource template and may contain declarations such as `model`, `blockstate`, or `item`.

```rsgl
template horizontal(model: ModelId) -> variants {
  { facing: north }: model
  { facing: east }: model y=90
  { facing: south }: model y=180
  { facing: west }: model y=270
}

template poweredOverlay(model: ModelId) -> multipart {
  when { powered: true } apply model
}

blockstate variants panel {
  use horizontal(model_id("block/panel"))
}

blockstate multipart lamp {
  apply model_id("block/lamp")
  use poweredOverlay(model_id("block/lamp_powered"))
}
```

Canonical blockstates put the mode directly after `blockstate`. Variant selectors use `{ property: value }: model`, while multipart entries use `apply` and `when { ... } apply`. Legacy `variants { ... }` / `multipart { ... }` wrappers, `[state=value] -> ...`, and `@model` sugar remain isolated compatibility paths that emit migration diagnostics; they should not be used in new source.

## Types, functions, IDs, and collections

RSGL evaluates abstraction logic at compile time. Type aliases and structural record types catch missing, excess, and incompatible fields. Optional record fields use `?`; function values use `(ParameterTypes) -> ReturnType` annotations and lambda expressions.

Resource references have distinct `ResourceId`, `ModelId`, `TextureId`, and `TextureRef` types. Use `resource_id(...)`, `model_id(...)`, or `texture_id(...)` when context cannot select the intended kind or when narrowing a plain string explicitly.

Collection operations include `map`, `filter`, `flatMap`, `concat`, `join`, `entries`, `keys`, `values`, `mergeObjects`, and `has`. Lists and objects support spread elements:

```rsgl
type Material = { texture: TextureId; tint?: Number }

let names = concat(["oak"], ["spruce", "birch"])
let textures: List<TextureId> = map(names, name => texture_id(`block/${name}_planks`))
let visible = filter(textures, texture => texture != texture_id("block/birch_planks"))
let defaults: Material = { texture: textures[0] }
let material: Material = { ...defaults, ...{ tint: 0 } }
let fields = keys(material)
```

Collection expansion is bounded by `maxEvaluationItems`, so malformed or unexpectedly large source does not grow without limit.

## Namespace imports

Use a namespace import when a module exports several related values or templates. Members remain qualified, which avoids collisions and makes their source clear.

`src/common.rsgl`:

```rsgl
let OAK: TextureId = texture_id("minecraft:block/oak_planks")

template cube(texture: TextureId) -> model {
  parent minecraft:block/cube_all
  textures { all: texture }
}

export { OAK, cube }
```

`src/main.rsgl`:

```rsgl
import * as common from "./common.rsgl"

model block oak_cube {
  use common.cube(common.OAK)
}
```

Named imports and bare side-effect imports are also supported. Default imports are not supported; use a named or namespace import instead.

## Model geometry transforms

`transform` applies an exact axis-aligned quarter-turn around an explicit pivot to every nested model-geometry statement. The compiler validates the operation, compile-time angle, pivot, and transformed geometry instead of relying on floating-point approximation.

```rsgl
template rotatedPost(texture: TextureId) -> model {
  textures { post: texture }
  transform rotate_y(90) around [8, 8, 8] {
    element from [6, 0, 1] to [10, 16, 5] {
      all texture "#post"
    }
  }
}

model block rotated_post {
  use rotatedPost(texture_id("minecraft:block/oak_log"))
}
```

The supported operations are `rotate_x`, `rotate_y`, and `rotate_z`. Nest transforms to compose several exact rotations.

## Project configuration

Place `rsgl.config.json` in a project directory or one of its ancestors. The extension provides validation and completion for every supported setting.

- `root` selects the source file or directory relative to the config file.
- `outDir` selects the generated output directory.
- `namespace` is a project default, not a hard override. Precedence is: an explicit compiler/API override, a source `namespace` declaration, the project setting, then `minecraft`.
- `target` is a project-wide Java Edition constraint. Set exactly one of `format` (for example `[50, 0]`) or `mc` (for example `"1.21.4"`). A matching source target is allowed; a conflicting one is diagnosed.
- `maxEvaluationItems` is the positive budget for bounded compile-time collection expansion and defaults to `100000`. It participates in compiler cache identity.
- `emitSourceMap`, `manifest`, `defaultAssetsPath`, `resourcePackRoots`, `extern`, and `checkExternExistence` control generated metadata and external resource validation.

Command-line `--out` overrides `outDir` for build, check, and watch operations without changing the config file.

## Migration and CLI

The language server diagnoses legacy blockstate and inferred root-template syntax. It offers conservative quick fixes for unambiguous blockstate rewrites; the CLI coordinates linked-program migration, including affected root templates. Review each diagnostic when migration requires a manual choice.

The CLI previews migration by default and writes only when explicitly requested:

```bash
rsgl migrate src
rsgl migrate src --write
```

`--write` applies the accepted migration atomically. Keep the project under version control and review the resulting diff before building.

The complete command surface is:

```text
rsgl init
rsgl build [root|file] [--out <dir>] [--preview] [--watch]
rsgl check [root|file] [--out <dir>]
rsgl migrate [root|file] [--write]
rsgl watch [root|file] [--out <dir>]
```

`--preview` is build-only, `--watch` is a build shortcut equivalent to the `watch` command, and `--write` is migration-only.
