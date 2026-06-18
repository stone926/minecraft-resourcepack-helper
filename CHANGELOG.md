# Changelog

## [Unreleased]

- Updated the extension target and toolchain to VS Code 1.125 and current npm dependency versions.
- Added cross-platform resource path resolution with configured vanilla asset fallback support.
- Added resource path completion and missing resource diagnostics.
- Added the Minecraft Resources sidebar for current-file and blockstate/model/texture mapping.
- Expanded the current-file sidebar view so opened blockstate files show nested model, parent model, and texture references.
- Added support for item model definition files under `assets/<namespace>/items`.
- Added model reference support for `base` fields in modern item model definitions.
- Added texture reference support for chest, shulker box, and copper golem statue special item models.
- Added resource navigation/completion support for atlases, equipment, fonts, waypoint styles, post-effect shaders, and sounds.
- Added JSON schemas for modern resource pack JSON files including particles, items, atlases, equipment, fonts, waypoint styles, post effects, sounds, language files, credits, GPU warnlists, and regional compliancies.
- Expanded PNG texture metadata validation to all `textures/**/*.png.mcmeta` files, including animation, texture sampling, and villager metadata.
- Updated new-pack metadata generation to use modern `min_format`/`max_format` fields with an 86.2 default.
- Updated new-pack scaffolds to create modern namespace directories such as `items`, `atlases`, `equipment`, `font`, `particles`, `post_effect`, `sounds`, `texts`, and `waypoint_style`.
- Fixed JSON edit-time crashes, CIT path matching, resource lifecycle leaks, unsafe pack metadata generation, and cancelled command input handling.
- Fixed resource-pack creation in multi-root workspaces by asking for the target workspace folder.
- Fixed OptiFine CIT resource resolution for relative paths, namespaced paths, and explicit `assets/` paths.
- Fixed texture variable lookup so parent model texture definitions are considered.

## [1.0.3]

- Added partial OptiFine CIT support.

## [1.0.2]

- Added Minecraft 1.19+ support.
- Fixed bugs.
