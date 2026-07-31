/**
 * Canonical project-anchor file names. mc-assets keeps its own
 * `pack.mcmeta` literal (it owns pack resolution below this layer); every
 * extension-side discovery, watcher, and scan surface derives from here.
 */
export const packMetadataFileName = "pack.mcmeta";
export const rsglProjectConfigFileName = "rsgl.config.json";

export const resourceProjectAnchorFileNames: readonly string[] = [
  packMetadataFileName,
  rsglProjectConfigFileName
];

export function isResourceProjectAnchorFileName(basename: string): boolean {
  const normalized = basename.toLowerCase();
  return resourceProjectAnchorFileNames.includes(normalized);
}

/** `vscode.workspace.createFileSystemWatcher` glob covering both anchors. */
export const resourceProjectAnchorWatcherGlob =
  `**/{${rsglProjectConfigFileName},${packMetadataFileName}}`;

/** `vscode.workspace.findFiles` include glob covering both anchors. */
export const resourceProjectAnchorSearchGlob =
  `{**/${packMetadataFileName},**/${rsglProjectConfigFileName}}`;
