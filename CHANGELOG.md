# Changelog

## [Unreleased]

## [2.0.3] - 2026-06-19

- fix: hide empty model inheritance expanders (16b1137)
- fix: align item model schemas with wiki specs (5ea1e1e)

## [2.0.2] - 2026-06-19

- fix: tighten resource pack metadata schemas (d80c791)
- fix: cover texture metadata and post effect resources (0be894c)
- fix: align resource pack schemas with wiki specs (defad7d)
- feat: support shader imports and special textures (63621be)
- feat: support modern resource pack specs (8a4a6f7)
- feat: support resource pack overlay fallbacks (99c03bf)
- fix: localize extension metadata (1c09cbd)

## [2.0.1] - 2026-06-19

- Maintenance release.

## [2.0.0] - 2026-06-19

- Updated the extension target and toolchain to VS Code 1.125 and current npm dependency versions.
- Added cross-platform resource path resolution with configured vanilla asset fallback support.
- Added resource path completion and missing resource diagnostics.
- Added resource path completion support for blank resource strings while avoiding empty-path diagnostics.
- Added the Minecraft Resources sidebar for current-file and blockstate/model/texture mapping.
- Expanded the current-file sidebar view so opened blockstate files show nested model, parent model, and texture references.
- Added support for item model definition files under `assets/<namespace>/items`.
- Added model reference support for `base` fields in modern item model definitions.
- Added texture reference support for chest, shulker box, and copper golem statue special item models.
- Added font file reference support for TTF and Unihex font providers.
- Added resource navigation/completion support for atlases, equipment, fonts, waypoint styles, post-effect shaders, and sounds.
- Added JSON schemas for modern resource pack JSON files including particles, items, atlases, equipment, fonts, waypoint styles, post effects, sounds, language files, credits, GPU warnlists, and regional compliancies.
- Expanded item model definition schema hints for modern condition, select, range dispatch, special model, and tint fields.
- Expanded PNG texture metadata validation to all `textures/**/*.png.mcmeta` files, including animation, texture sampling, and villager metadata.
- Added PNG metadata validation for GUI sprite scaling and modern texture mipmap strategy fields.
- Updated new-pack metadata generation to use modern `min_format`/`max_format` fields with an 86.2 default.
- Updated new-pack scaffolds to create modern namespace directories such as `items`, `atlases`, `equipment`, `font`, `particles`, `post_effect`, `sounds`, `texts`, and `waypoint_style`.
- Fixed JSON edit-time crashes, CIT path matching, resource lifecycle leaks, unsafe pack metadata generation, and cancelled command input handling.
- Fixed resource-pack creation in multi-root workspaces by asking for the target workspace folder.
- Fixed the resource graph block list so it no longer stops after 300 blockstate files.
- Improved resource graph performance by loading each block's model and texture children only when the block is expanded.
- Fixed OptiFine CIT resource resolution for relative paths, namespaced paths, and explicit `assets/` paths.
- Fixed texture variable lookup so parent model texture definitions are considered.
- Fixed misspelled block model schema range keywords so coordinate and rotation limits validate correctly.

## [1.0.3]

- Added partial OptiFine CIT support.

## [1.0.2]

- Added Minecraft 1.19+ support.
- Fixed bugs.
