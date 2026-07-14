# Changelog

## [Unreleased]

- feat(rsgl): add explicit template output dialects and canonical variants/multipart blockstates with editor and CLI migration support.
- feat(rsgl): retain legacy template and blockstate forms behind targeted compatibility warnings and conservative migrations.
- feat(rsgl): add structural record types, function values, typed resource IDs, bounded collection composition and spread, and namespace imports.
- feat(rsgl): add exact axis-aligned quarter-turn model geometry transforms shared with model preview geometry semantics.
- feat(rsgl): expand language-server completion, formatting, navigation, rename, semantic highlighting, and project-configuration diagnostics for the new language surface.
- test(rsgl): add reproducible compiler/source-map performance benchmarks and restore the model-preview benchmark smoke gate.

## [2.3.1] - 2026-07-01

- test: cover resource completion paths (5211173)
- fix: preserve namespace completion filtering (ebc4cc5)
- fix: use fresh references for resource completion (f94fdd2)
- fix: retrigger resource completion after namespaces (0af7878)
- fix: filter invalid namespace completion roots (5fb3487)
- fix: complete resource paths while editing models (2b2e4e5)
- docs: update i18n user notes (63bcc3d)
- feat: localize model preview webview (86b535c)
- feat: localize model preview issues (5c3cfbf)
- feat: localize runtime diagnostics (ab4c2d7)
- test: strengthen i18n coverage (f0be937)

## [2.3.0] - 2026-07-01

- fix: linter translation and alingment (49e3ce3)
- feat: json linter i18n (0a55841)
- feat: add workspace resource cache (ff330ba)
- update ignore (388391e)
- perf: cache resource graph scans (e336780)
- fix(model-preview): align export transparent checkbox (24cf6e1)
- fix gitignore (06e59a5)
- feat(model-preview): implement P0 and P1 iterations (ee350d2)

## [2.2.3] - 2026-06-30

- fix item generated model preview rendering (a4b27b4)

## [2.2.2] - 2026-06-30

- fix model preview missing texture pattern (76bc966)
- fix model preview minecraft negative cuboids (daddf5b)
- fix model preview negative cuboid rendering (4bd9b85)

## [2.2.1] - 2026-06-30

- fix: show model preview editor button (e18c6af)

## [2.2.0] - 2026-06-29

- fix: tweak height (5ff54b7)
- fix(model-preview): adapt bottom details height (dd96864)
- fix(model-preview): shrink collapsed bottom details (2f72917)
- fix(model-preview): tune camera fit and details panel (a80d27e)
- fix(model-preview): initialize webview renderer reliably (b321eb2)
- perf(model-preview): vendor minimal three runtime (13eef6c)
- feat(model-preview): add interactive webview preview (f8c42f0)
- feat(model-preview): resolve and bake preview documents (2b7f542)
- fix: stop creating unreleased changelog section (cfa62bb)

## [2.1.1] - 2026-06-29

- update md (06be6df)
- update md (89ecb89)

## [2.1.0] - 2026-06-29

- fix: correct vscode package ignore rules (a75b9dd)
- update ignore (ea1ff31)
- fix: add lightweight non-json resource diagnostics (dc3be82)
- reivew extra files (d1553ab)
- fix: align resource pack spec validation (c1553f8)
- update gitignore and package.json (0cfbeea)
- unlicensed license (08849d0)

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
