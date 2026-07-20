# RSGL CLI

The command-line compiler and project tooling for the Resourcepack Generation Language (RSGL).

## Install

Requires Node.js 20 or newer.

```bash
npm install --global @minecraft-resourcepack-helper/rsgl-cli
```

You can also run a specific version without a global install:

```bash
npx --package @minecraft-resourcepack-helper/rsgl-cli rsgl --help
```

## Commands

```text
rsgl init
rsgl build [root|file] [--out <dir>] [--preview] [--watch]
rsgl check [root|file] [--out <dir>]
rsgl watch [root|file] [--out <dir>]
```

Place `rsgl.config.json` in a project directory, then run the commands from that directory. Command-line `--out` overrides the configured `outDir` without modifying the project file.

The same language, project, external-resource, and ownership semantics are built into the Minecraft Resourcepack Helper VS Code extension. The CLI remains a separately versioned npm artifact for terminal and CI workflows.

## License

[The Unlicense](LICENSE)
