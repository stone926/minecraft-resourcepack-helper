import * as vscode from "vscode";
import {
  createStableResourceProjectRevision,
  type SerializedResourceUri
} from "../../packages/resource-project/src";
import { getResourceConfiguration } from "../utils/resourceConfiguration";
import { sharedConfigurationFromSettings } from "./sharedConfiguration";
import type {
  ResourcePackProjectServiceHost,
  ResourceProjectTextFile,
  ResourceProjectWorkspaceFolder
} from "./types";

/** VS Code filesystem/configuration boundary for the URI-neutral service. */
export class VscodeResourcePackProjectHost implements ResourcePackProjectServiceHost {
  private workspaceFolders?: readonly ResourceProjectWorkspaceFolder[];

  public async stat(uri: SerializedResourceUri): Promise<"file" | "directory" | null> {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.parse(uri, true));
      if ((stat.type & vscode.FileType.File) !== 0) {
        return "file";
      }
      if ((stat.type & vscode.FileType.Directory) !== 0) {
        return "directory";
      }
      return null;
    } catch {
      return null;
    }
  }

  public async readTextFile(uri: SerializedResourceUri): Promise<ResourceProjectTextFile | null> {
    const vscodeUri = vscode.Uri.parse(uri, true);
    try {
      const [stat, bytes] = await Promise.all([
        vscode.workspace.fs.stat(vscodeUri),
        vscode.workspace.fs.readFile(vscodeUri)
      ]);
      const text = Buffer.from(bytes).toString("utf8");
      return {
        text,
        revision: createStableResourceProjectRevision("vscode-file", {
          ctime: stat.ctime,
          mtime: stat.mtime,
          size: stat.size,
          text
        })
      };
    } catch {
      return null;
    }
  }

  public getWorkspaceFolders(): readonly ResourceProjectWorkspaceFolder[] {
    if (this.workspaceFolders) {
      return this.workspaceFolders;
    }
    this.workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map(folder => {
      const folderUri = folder.uri.toString();
      const configuration = getResourceConfiguration(folder.uri);
      const vanillaResourcePackPath = configuration.defaultAssetsPath;
      const customResourcePackPaths = configuration.resourcePackRoots ?? [];
      const sharedConfiguration = sharedConfigurationFromSettings(
        folderUri,
        vanillaResourcePackPath,
        customResourcePackPaths
      );
      return {
        uri: folderUri,
        sharedConfiguration,
        configurationRevision: createStableResourceProjectRevision("workspace-settings", {
          folderUri,
          vanillaResourcePackPath,
          customResourcePackPaths
        })
      };
    });
    return this.workspaceFolders;
  }

  /** Configuration and workspace-folder events explicitly expire this snapshot. */
  public invalidateWorkspaceFolders(): void {
    this.workspaceFolders = undefined;
  }
}
