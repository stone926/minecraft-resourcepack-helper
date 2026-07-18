# Minecraft Resourcepack Helper

[中文说明](README_CN.md)

Minecraft Resourcepack Helper is a VS Code extension for Minecraft Java resource pack authors. It understands modern resource pack layouts and adds resource-location aware navigation, completion, diagnostics, JSON validation, model preview, and reference views while you edit.

## Preview

![Resource path completion](assets/completion.gif)

![Go to definition](assets/definition.gif)

![Validation diagnostics](assets/validitor.gif)

## Highlights

- Go to Definition and resource path completion for blockstates, block/item models, modern item model definitions, particles, atlases, equipment, fonts, waypoint styles, post effects, sounds, and shader imports.
- Go to Definition, completion, missing-resource diagnostics, and resource graph support for CIT `.properties` texture and model paths, and CIT model JSON files under `citresewn/`.
- Missing resource diagnostics that resolve through the current pack, pack overlays and filters, configured lower-priority packs, and vanilla assets.
- Model texture variable support: jump to `#texture` definitions, follow variables inherited from parent models, highlight undefined variables, and report cyclic texture variables or too-deep parent chains.
- A Minecraft Resources activity bar view for current-file references, incoming references, model inheritance, child models, and blockstate -> model -> texture relationships.
- Three.js model preview for model JSON files, with texture/solid/wireframe modes, camera presets, perspective/orthographic cameras, grid and axis toggles, issue/dependency panels, live refresh, and PNG export.
- JSON schema validation for supported resource pack files, including pack metadata, models, item definitions, particles, atlases, equipment, fonts, sounds, language files, credits, GPU warnlists, regional compliancies, and PNG texture metadata.
- Extra semantic checks for `pack.mcmeta`, `pack.png`, colormap PNG sizes, `sounds.json`, post-effect targets, model parent/texture-variable chains, and `assets/<namespace>/texts/{splashes,end,postcredits}.txt`.
- English and Simplified Chinese localization for extension commands, runtime prompts, diagnostics, resource graph labels, model preview issues, and model preview webview controls.
- Commands for scaffolding a modern resource pack with namespace folders, a default `pack.png`, and `min_format`/`max_format` pack metadata.
- Optional RSGL support through the companion `stone926.rsgl` extension, which is included in this extension pack and owns `.rsgl` language features, build commands, and the bundled language server.

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=stone926.minecraft-resourcepack-helper).
2. Open a folder that contains a Minecraft resource pack `pack.mcmeta`.
3. Configure `McResHelper.defaultMcAssetsPath` if you want navigation, completion, diagnostics, the resource graph, and model preview to fall back to vanilla assets.
4. Optional: configure `McResHelper.resourcePackLoadOrder` with absolute paths to lower-priority resource pack roots.
5. Open a supported resource pack file and use Go to Definition, path suggestions, diagnostics, the Minecraft Resources activity bar view, or model preview for model JSON files.

The extension activates automatically when the workspace contains `pack.mcmeta`. The Marketplace install also offers the RSGL companion through an extension pack; it can be removed independently, and Minecraft Resourcepack Helper continues to work without it.

## Resource Resolution

Navigation, completion, diagnostics, the resource graph, and model preview use the same load-order model where possible:

1. The resource pack currently being edited.
2. Active overlays and filters declared in `pack.mcmeta`.
3. Enabled lower-priority packs from `McResHelper.resourcePackLoadOrder`, ordered from higher priority to lower priority.
4. Vanilla assets from `McResHelper.defaultMcAssetsPath`.

## Model Preview

Open **McResHelper: open model preview** from a model JSON editor, the editor title/context menu, or a model node in the Minecraft Resources view.

The preview resolves parent models, textures, texture variables, `.png.mcmeta` texture metadata, the configured resource-pack load order, and vanilla assets. It renders cuboid models and generated item models in a VS Code webview, then refreshes when related model, texture, metadata, active editor, or configuration changes are detected.

Preview controls include:

- View presets: 3/4, front, back, left, right, top, and bottom.
- Perspective and orthographic cameras.
- Textured, solid, and wireframe display modes.
- Grid and axis visibility toggles.
- Clickable Issues and Dependencies lists for related files and configuration.
- PNG export with custom width and height, transparent background, or a selected background color.

Current scope: model preview supports Minecraft model JSON resources and CIT `.properties` asset previews. Some visual details are approximated, including generated item side extrusion when texture pixels cannot be decoded, animated textures where only the first loaded PNG frame is shown, and element rotation `rescale`.

CIT `.properties` preview is an asset preview, not a full CIT runtime simulation. It resolves the main `model` or `texture` and renders the resulting model/texture where possible, but it does not evaluate every matching branch or render-layer behavior. In particular, `texture.*`, `tile.*`, `model.*` state variants, item condition matching, enchantment glint layers, blend behavior, and armor/equipment layer selection may differ from the in-game CIT Resewn result.

## Supported References

- `assets/<namespace>/blockstates/**/*.json`: model references from variants and multipart entries.
- `assets/<namespace>/models/**/*.json`: parent model references and texture references, including texture variables.
- `assets/<namespace>/items/**/*.json`: modern item model definitions, nested models, special model bases, and supported special textures.
- `assets/<namespace>/particles/**/*.json`: particle texture references.
- `assets/<namespace>/atlases/**/*.json`: atlas texture and texture-directory references.
- `assets/<namespace>/equipment/**/*.json`: equipment layer texture references.
- `assets/<namespace>/font/**/*.json`: font references plus bitmap, TTF, and Unihex provider files.
- `assets/<namespace>/waypoint_style/**/*.json`: locator bar sprite textures.
- `assets/<namespace>/post_effect/**/*.json`: post-effect shader references and effect textures.
- `assets/<namespace>/sounds.json`: sound file references and sound event sanity checks.
- `assets/<namespace>/shaders/{core,post}/**/*.{vsh,fsh}`: `#moj_import` shader include references.
- CIT `.properties`: texture and model path definition, completion, missing-resource diagnostics, and resource graph support.
- CIT model JSON: model and texture references from CitResewn JSON model files under `assets/<namespace>/citresewn/`.

## Diagnostics And Validation

The extension combines VS Code JSON schemas with resource-aware diagnostics.

- Missing resource warnings use the same resolution rules as navigation and completion.
- `pack.mcmeta` checks cover modern `min_format`/`max_format` usage, legacy `pack_format`, and packs that cross the 1.21.8 format boundary.
- Non-JSON checks cover missing or invalid `pack.png`, invalid or incorrectly sized colormap PNG files, and UTF-8 or formatting issues in `splashes.txt`, `end.txt`, and `postcredits.txt`.
- `sounds.json` checks cover sound file references, whitespace in sound file names, unnecessary `.ogg` extensions, invalid numeric fields, and undefined sound event references.
- `post_effect` checks verify target/pass relationships.
- Model checks cover parent-chain depth, parent cycles, missing textures, missing texture variables, and cyclic texture-variable chains.

## Resource Graph

The **Minecraft Resources** activity bar view follows the active editor and shows the resource graph around it.

- Current file: the active resource itself.
- References: outgoing model, texture, shader, font, sound, and texture-directory references.
- Referenced By: incoming references from files in the workspace.
- Model Inheritance: parent models and child models.
- Blocks: workspace blockstates grouped as entry points into blockstate -> model -> texture chains.

The view has cached workspace indexes and can be refreshed manually with **McResHelper: refresh resource graph**.

## RSGL

RSGL support is split into a separate VS Code extension: `stone926.rsgl`. It is included in the main extension's extension pack for convenient installation, but it is not a runtime dependency and can be removed independently.

The RSGL extension owns:

- `.rsgl` language registration, syntax highlighting, language configuration, diagnostics, completion, hover, and formatting.
- RSGL build and preview commands such as **RSGL: Build Resourcepack JSON**, **RSGL: Preview Build**, **RSGL: Build Source Directory**, and workspace build variants.
- VS Code settings under the `rsgl.*` namespace for the output directory, vanilla assets fallback, and lower-priority resource packs.
- Project compiler options in `rsgl.config.json`, including the Minecraft target, source maps, generated JSON validation, source roots, and evaluation limits.
- The bundled RSGL language server plus shared compiler/core packages.

The current language surface accepts canonical syntax only, including explicit `model` / `variants` / `multipart` / `choice` template dialects and canonical blockstates. It also includes structural record types and function values, typed resource IDs, bounded collection operations and spread, namespace imports, and exact quarter-turn model-geometry transforms. See the [RSGL companion extension guide](extensions/vscode-rsgl/README.md) for compilable examples, project configuration, and CLI usage.

## Configuration

- `McResHelper.defaultMcAssetsPath`: absolute path to vanilla Minecraft assets. It can point at an `assets` folder, an `assets/minecraft` folder, or a resource pack root containing `assets/minecraft`.
- `McResHelper.resourcePackLoadOrder`: absolute paths to enabled resource pack roots below the currently edited pack, ordered from higher priority to lower priority. The current pack is checked first, then this list, then vanilla assets.
- `McResHelper.tipColorForUndefinedTextureVariables`: color used to highlight undefined `#texture` variables in model files.

Example:

```json
{
  "McResHelper.defaultMcAssetsPath": "C:/.minecraft/my_test/26.2/assets/minecraft",
  "McResHelper.resourcePackLoadOrder": [
    "C:/.minecraft/resourcepacks/base_pack"
  ],
  "McResHelper.tipColorForUndefinedTextureVariables": "Chartreuse"
}
```

## Commands

- `McResHelper: open folder of vanilla assets`
- `McResHelper: create a new pack in current folder`
- `McResHelper: create a new pack with the current folder as the root directory`
- `McResHelper: refresh resource graph`
- `McResHelper: open model preview`
- `McResHelper: export model preview image`
- `McResHelper: open model preview from resource graph`
- `McResHelper: create CIT template`
- `McResHelper: generate CIT for current item`

The model preview commands are also available from model JSON editor menus. Resource graph model nodes provide an inline preview action. The CIT commands are accessible from the command palette; "generate CIT for current item" also appears in the editor context menu for item textures and models.

RSGL commands are provided by the companion RSGL extension and use the `RSGL:` command prefix.

## Scaffolding

The resource-pack creation commands prompt for pack name, namespace, target resource-pack format, and description. They create `pack.mcmeta`, a default `pack.png`, and common namespace folders such as `blockstates`, `models`, `items`, `textures`, `sounds`, `font`, `atlases`, `equipment`, `post_effect`, `shaders`, and `waypoint_style`.

## Development

```bash
npm install
npm run compile:all
npm run lint
npm test
```

Useful focused commands:

```bash
npm run benchmark:model-preview
npm run compile:rsgl-extension
npm run package:main:vsix
npm run package:rsgl:vsix
npm run package:rsgl-cli
```

The repository contains the main extension at the root, shared RSGL packages under `packages/rsgl-*`, and the standalone RSGL VS Code extension under `extensions/vscode-rsgl`. RSGL unit tests live with the core package in `packages/rsgl-core/test/unit`.

The three public products release independently: the main extension uses `vX.Y.Z`, the RSGL extension uses `rsgl-vX.Y.Z`, and the npm CLI uses `rsgl-cli-vX.Y.Z`. Use `npm run release:main`, `npm run release:rsgl`, or `npm run release:rsgl-cli` so only that product's manifest, changelog, artifact, and tag are advanced. The prepared RSGL 1.0.0 first releases use `npm run release:rsgl:current` and `npm run release:rsgl-cli:current`; later release commands increment only their selected product by one patch unless an explicit version is supplied to `scripts/release.mjs`.

The release script atomically pushes the current branch and exactly one target tag, with bounded retries only for transport failures. If the remote connection still fails after creating the local release commit/tag, and that tag still points exactly to HEAD, resume with `node scripts/release.mjs <main|rsgl|rsgl-cli> current --resume`; do not push only the branch, because that does not start the tag workflow.

## Links

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=stone926.minecraft-resourcepack-helper)
- [RSGL companion extension](https://marketplace.visualstudio.com/items?itemName=stone926.rsgl)
- [Repository](https://github.com/stone926/minecraft-resourcepack-helper)
