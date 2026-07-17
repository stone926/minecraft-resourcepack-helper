# Changelog

## [Unreleased]

## [1.0.0]

- refactor(rsgl): separate path identity from display paths, remove compiler runtime cycles, and split evaluator, compiler, and semantic-checking responsibilities.
- perf(rsgl): schedule diagnostics by dirty document/dependent generation, use exact/pattern/structural dependency watchers, and retain TTL verification where watcher delivery is not reliable.
- build(rsgl): bundle the extension, language server, and worker independently; remove the synchronous extension API and add an explicit workspace refresh command.
- breaking(rsgl): accept only canonical template and blockstate syntax, require explicit module exports, and remove migration and compatibility surfaces from the compiler, language server, CLI, and public APIs.
- feat(rsgl): add structural record types, function values, typed resource IDs, bounded collection composition and spread, and namespace imports.
- feat(rsgl): add exact axis-aligned quarter-turn model geometry transforms shared with model preview geometry semantics.
- feat(rsgl): expand language-server completion, formatting, navigation, rename, semantic highlighting, and project-configuration diagnostics for the new language surface.
- test(rsgl): add reproducible compiler/source-map performance benchmarks and restore the model-preview benchmark smoke gate.
- Initial standalone RSGL extension package split from Minecraft Resourcepack Helper.
