# Minecraft Resourcepack Helper

Minecraft Resourcepack Helper helps Minecraft resource pack authors work with JSON-based pack files in VS Code.

## Features

- Go to definitions for blockstate models, model parents, model textures, particle textures, item model definitions including special item model textures, atlases, equipment, fonts, waypoint styles, post-effect shaders, sounds, and OptiFine CIT texture/model paths.
- Resource path completion for blockstates, block/item models, particles, item model definitions, special item model textures, atlases, equipment, fonts, waypoint styles, post-effect shader files, and sounds.
- Missing resource diagnostics with overlay-to-base-pack fallback and fallback support through `McResHelper.defaultMcAssetsPath`.
- Texture variable navigation and undefined variable highlighting in model files, including variables inherited through parent models.
- Minecraft Resources sidebar showing the current file references and blockstate -> model -> texture relationships, including resources inside pack overlays.
- JSON validation for supported resource pack file types, including modern JSON files and PNG texture metadata.
- Commands for creating a resource pack scaffold.

## Configuration

- `McResHelper.defaultMcAssetsPath`: absolute path to vanilla Minecraft assets. The path may point at an `assets` folder, an `assets/minecraft` folder, or a resource pack root containing `assets/minecraft`.
- `McResHelper.tipColorForUndefinedTextureVariables`: color used to highlight undefined `#texture` variables in model files.

## Commands

- `McResHelper: open folder of vanilla assets`
- `McResHelper: create a new pack in current folder`
- `McResHelper: create a new pack with the current folder as the root directory`
- `McResHelper: refresh resource graph`

## Install

You can install it from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=stone926.minecraft-resourcepack-helper).

## Repository

[https://github.com/stone926/minecraft-resourcepack-helper](https://github.com/stone926/minecraft-resourcepack-helper)
