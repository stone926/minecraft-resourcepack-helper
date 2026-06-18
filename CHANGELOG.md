# Changelog

## [Unreleased]

- Updated the extension target and toolchain to VS Code 1.125 and current npm dependency versions.
- Added cross-platform resource path resolution with configured vanilla asset fallback support.
- Added resource path completion and missing resource diagnostics.
- Added the Minecraft Resources sidebar for current-file and blockstate/model/texture mapping.
- Added support for item model definition files under `assets/<namespace>/items`.
- Added resource navigation/completion support for atlases, equipment, fonts, waypoint styles, and post-effect shaders.
- Added JSON schemas for modern resource pack JSON files including particles, items, atlases, equipment, fonts, waypoint styles, and post effects.
- Fixed JSON edit-time crashes, CIT path matching, resource lifecycle leaks, unsafe pack metadata generation, and cancelled command input handling.
- Fixed OptiFine CIT resource resolution for relative paths, namespaced paths, and explicit `assets/` paths.
- Fixed texture variable lookup so parent model texture definitions are considered.

## [1.0.3]

- Added partial OptiFine CIT support.

## [1.0.2]

- Added Minecraft 1.19+ support.
- Fixed bugs.
