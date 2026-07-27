import * as vscode from 'vscode';
import { isSamePath } from '../../packages/mc-assets/src';
import type { CachedTextureVariableDefinition } from '../services/modelParentChain';
import { workspaceResourceCache } from '../services/workspaceResourceCache';
import { isInArea } from '../utils/locationChecker';
import {
  collectTextureVariableReferenceNodes,
  createTextureVariableDefinitionResolver
} from '../utils/modelTexture';
import { getResourceConfiguration } from '../utils/resourceConfiguration';

export default (document: vscode.TextDocument, position: vscode.Position) => {
  const ast = workspaceResourceCache.getJsonAst(document);
  if (!ast) {
    return null;
  }

  const line = position.line + 1;
  const character = position.character + 1;
  const textureVariableResolver = createTextureVariableDefinitionResolver(
    ast,
    document,
    getResourceConfiguration
  );

  for (const reference of collectTextureVariableReferenceNodes(ast.body)) {
    if (isInArea(line, character, reference.node.loc)) {
      const definition = textureVariableResolver.resolve(reference.value);
      return definition ? toLocation(document, definition) : null;
    }
  }

  return null;
};

function toLocation(document: vscode.TextDocument, definition: CachedTextureVariableDefinition): vscode.Location {
  const uri = isSamePath(definition.fileName, document.fileName)
    ? document.uri
    : vscode.Uri.file(definition.fileName);
  return new vscode.Location(uri, new vscode.Position(definition.line, definition.character));
}

