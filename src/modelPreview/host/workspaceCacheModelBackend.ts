import { evaluate } from "@humanwhocodes/momoa";
import type { ResourceFileRequest } from "../../../packages/mc-assets/src";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import type { ModelPreviewFileSystem } from "../model/ModelDocument";
import type { ParentChainModelLoader } from "../resolve/RawModelLoader";

/**
 * Parent-chain loading backed by the shared workspace caches.
 *
 * Model JSON values come from the workspace AST cache (`getJsonFileAst`), so a
 * model file edited in the editor is parsed once and shared between semantic
 * diagnostics and the preview instead of once per subsystem. The raw text is
 * still read through the preview file system because location collection needs
 * the exact source. When the shared cache cannot parse the file, the text is
 * parsed directly so the resolver keeps its precise parse-error positions.
 */
export function createWorkspaceCacheModelLoader(fileSystem: ModelPreviewFileSystem): ParentChainModelLoader {
  return {
    readModelText: fileName => fileSystem.readTextFile(fileName),
    parseModelValue(fileName, text) {
      const ast = workspaceResourceCache.getJsonFileAst(fileName);
      return ast ? evaluate(ast) : JSON.parse(text);
    }
  };
}

/** Non-CIT resource lookups routed through the shared resolution cache. */
export function resolveWorkspaceResourcePath(request: ResourceFileRequest): string | null {
  return workspaceResourceCache.resolveResourcePath(request);
}
