# Minecraft Resourcepack Helper

[中文说明](README_CN.md)

Minecraft Resourcepack Helper is a VS Code extension for Minecraft Java resource pack authors. It understands modern resource pack files and adds resource-location aware navigation, completion, diagnostics, validation, and reference views while you edit.

## Preview

![Resource path completion](assets/completion.gif)

![Go to definition](assets/definition.gif)

![Validation diagnostics](assets/validitor.gif)

## Highlights

- Go to Definition and resource path completion for blockstates, block/item models, modern item model definitions, particles, atlases, equipment, fonts, waypoint styles, post effects, sounds, shader imports, and OptiFine CIT texture/model paths.
- Missing resource diagnostics that resolve through the current pack, active pack overlays, configured lower-priority packs, and vanilla assets.
- Model texture variable support: jump to `#texture` definitions, use variables inherited from parent models, highlight undefined variables, and report cyclic texture variables or too-deep parent chains.
- Minecraft Resources activity bar view for current-file references, incoming references, child models, and blockstate -> model -> texture relationships.
- JSON schema validation for supported resource pack files, including pack metadata, models, item definitions, particles, atlases, equipment, fonts, sounds, language files, credits, GPU warnlists, regional compliancies, and PNG texture metadata.
- Extra semantic checks for `pack.mcmeta`, `pack.png`, colormap PNG sizes, `sounds.json`, post-effect targets, and `assets/<namespace>/texts/{splashes,end,postcredits}.txt`.
- Commands for scaffolding a modern resource pack with namespace folders and `min_format`/`max_format` pack metadata.

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=stone926.minecraft-resourcepack-helper).
2. Open a folder that contains a Minecraft resource pack `pack.mcmeta`.
3. Configure `McResHelper.defaultMcAssetsPath` if you want navigation, completion, diagnostics, and the resource graph to fall back to vanilla assets.
4. Optional: configure `McResHelper.resourcePackLoadOrder` with absolute paths to lower-priority resource pack roots.
5. Open a supported resource pack file and use Go to Definition, path suggestions, diagnostics, or the Minecraft Resources activity bar view.

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
- OptiFine CIT `.properties`: texture and model path definition support.

## Configuration

- `McResHelper.defaultMcAssetsPath`: absolute path to vanilla Minecraft assets. It can point at an `assets` folder, an `assets/minecraft` folder, or a resource pack root containing `assets/minecraft`.
- `McResHelper.resourcePackLoadOrder`: absolute paths to enabled lower-priority resource pack roots. The current pack is checked first; this list is used before vanilla assets.
- `McResHelper.tipColorForUndefinedTextureVariables`: color used to highlight undefined `#texture` variables in model files.

Example:

```json
{
  "McResHelper.defaultMcAssetsPath": "E:/.minecraft/my_test/26.2/assets/minecraft",
  "McResHelper.resourcePackLoadOrder": [
    "E:/.minecraft/resourcepacks/base_pack"
  ],
  "McResHelper.tipColorForUndefinedTextureVariables": "Chartreuse"
}
```

## Commands

- `McResHelper: open folder of vanilla assets`
- `McResHelper: create a new pack in current folder`
- `McResHelper: create a new pack with the current folder as the root directory`
- `McResHelper: refresh resource graph`

## Development

```bash
npm install
npm run compile
npm run lint
npm test
```

Useful references:

- [Project index](docs/AGENT_INDEX.md)
- [Minecraft resource pack spec notes](docs/Minecraft资源包规范完整手册.md)

## Links

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=stone926.minecraft-resourcepack-helper)
- [Repository](https://github.com/stone926/minecraft-resourcepack-helper)
