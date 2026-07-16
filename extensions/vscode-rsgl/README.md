# RSGL - Resourcepack Generation Language

Standalone VS Code extension for editing, validating, and building Minecraft Java Edition resource packs from `.rsgl` source files.

## Features

- Language registration and syntax highlighting for `.rsgl` files.
- Completion, diagnostics, hover, signature help, navigation, rename, semantic highlighting, and formatting powered by the bundled RSGL language server.
- VS Code build and preview commands for a single file, a source directory, or configured workspace roots, plus CLI check and watch workflows.
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
  "maxEvaluationItems": 100000,
  "maxItemModelDepth": 128
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
  case * => modelFor("oak_panel")
}
```

Run `rsgl check` to validate without writing, `rsgl build` to emit the generated resource-pack files, or use the matching **RSGL:** commands from the Command Palette.

## Explicit template dialects

A body-fragment template declares its output dialect after `->`. This makes a template's valid statements and every `use` site unambiguous:

- `-> model` emits model-body fields and geometry.
- `-> variants` emits canonical blockstate variant entries.
- `-> multipart` emits canonical blockstate multipart entries.
- `-> choice` emits options inside one blockstate random choice.
- `-> item_model` emits exactly one recursive item-model node.

A template without an arrow remains a complete-resource template and may contain declarations such as `model`, `blockstate`, or `item`.

```rsgl
template horizontal(model: ModelId) -> variants {
  case { facing: north } => model
  case { facing: east } => model with { y: 90 }
  case { facing: south } => model with { y: 180 }
  case { facing: west } => model with { y: 270 }
}

template poweredOverlay(model: ModelId) -> multipart {
  part when $state.powered == true => model
}

template weatheredOptions(base: ModelId, alternate: ModelId) -> choice {
  option base weight 3
  option alternate
}

blockstate variants panel {
  use horizontal(model_id("block/panel"))
}

blockstate multipart lamp {
  part always => model_id("block/lamp")
  use poweredOverlay(model_id("block/lamp_powered"))
}

blockstate variants weathered_panel {
  case * => random {
    use weatheredOptions(
      model_id("block/weathered_panel"),
      model_id("block/weathered_panel_alt")
    )
  }
}
```

RSGL accepts canonical blockstates only: put the mode directly after `blockstate`; write `case <selector> => <choice>` for variants and `part always => <choice>` or `part when <StatePredicate> => <choice>` for multipart. A model choice is a `ModelId` expression with optional `with { x, y, z, uvlock }`; weighted alternatives belong in `random { option ... }`.

## Recursive item models and conventions

Item-model constructors are recursive: `case`, `fallback`, `on_true`, `on_false`, `model`, `entry`, `frames`, and ordered `first_match` branches can contain another constructor or `use` an `-> item_model` template. A model leaf accepts postfix `with { tints, transformation }` options.

The bundled `rsgl:conventions/item_definitions.rsgl` module includes reusable, data-driven helpers:

- `potionItem(id, folder, potions)` emits a complete potion item from a caller-owned ordered table.
- `orderedEnchantedBookItemModel(enchantments, fallbackModel) -> item_model` preserves both enchantment priority and level order.
- `tridentVariantItemModel(suffix, fallbackModel) -> item_model` shares one enchantment decision tree across the normal, in-hand, and throwing variants.
- `selfMappedItems(ids)` maps each caller-provided item id to its same-named model.
- `tintedSpawnEggItemModel(baseModel, baseColor, highlightColor) -> item_model` adds two constant tints only when colors are explicitly supplied.

```rsgl
import {
  potionItem,
  selfMappedItems,
  tintedSpawnEggItemModel
} from "rsgl:conventions/item_definitions.rsgl"

let potions = [
  { id: minecraft:mundane, stem: "mundane" },
  { id: minecraft:long_night_vision, stem: "night_vision_long" }
]

use potionItem(id: minecraft:potion, folder: "normal", potions: potions)

use selfMappedItems(ids: [
  minecraft:allay_spawn_egg,
  minecraft:armadillo_spawn_egg
])

item custom_spawn_egg {
  use tintedSpawnEggItemModel(
    baseModel: minecraft:item/custom_spawn_egg,
    baseColor: -6265536,
    highlightColor: [1, 0.5, 0]
  )
}
```

The conventions deliberately contain no potion, general enchantment, or spawn-egg registry. Keep those lists in project source so their aliases, order, and Minecraft-version binding remain explicit.

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
Expanded recursive item models are independently bounded by `maxItemModelDepth`, measured in edges from a root at depth 0.

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

Named imports and bare side-effect imports are also supported. Only explicitly exported names are importable. Default imports are not supported; use a named or namespace import instead.

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
- `maxItemModelDepth` is the positive expanded item-model recursion limit, measured in edges from root depth 0, and defaults to `128`. It participates in compiler cache identity.
- `emitSourceMap`, `manifest`, `defaultAssetsPath`, `resourcePackRoots`, `extern`, and `checkExternExistence` control generated metadata and external resource validation.

Command-line `--out` overrides `outDir` for build, check, and watch operations without changing the config file.

## CLI

The complete command surface is:

```text
rsgl init
rsgl build [root|file] [--out <dir>] [--preview] [--watch]
rsgl check [root|file] [--out <dir>]
rsgl watch [root|file] [--out <dir>]
```

`--preview` is build-only, and `--watch` is a build shortcut equivalent to the `watch` command.
