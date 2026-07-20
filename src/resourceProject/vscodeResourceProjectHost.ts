import * as vscode from "vscode";
import {
  createStableResourceProjectRevision,
  type SerializedResourceUri
} from "../../packages/resource-project/src";
import { sharedConfigurationFromSettings } from "./sharedConfiguration";
import type {
  ResourcePackProjectServiceHost,
  ResourceProjectTextFile,
  ResourceProjectWorkspaceFolder
} from "./types";

/** VS Code filesystem/configuration boundary for the URI-neutral service. */
export class VscodeResourcePackProjectHost implements ResourcePackProjectServiceHost {
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
    return (vscode.workspace.workspaceFolders ?? []).map(folder => {
      const folderUri = folder.uri.toString();
      const configuration = vscode.workspace.getConfiguration("McResHelper", folder.uri);
      const defaultAssetsPath = configuration.get<string | null>("defaultMcAssetsPath");
      const resourcePackLoadOrder = configuration.get<string[]>("resourcePackLoadOrder") ?? [];
      const sharedConfiguration = sharedConfigurationFromSettings(
        folderUri,
        defaultAssetsPath,
        resourcePackLoadOrder
      );
      return {
        uri: folderUri,
        sharedConfiguration,
        configurationRevision: createStableResourceProjectRevision("workspace-settings", {
          folderUri,
          defaultAssetsPath,
          resourcePackLoadOrder
        })
      };
    });
  }
}
