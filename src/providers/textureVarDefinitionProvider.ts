import * as vscode from 'vscode';
import { isSamePath } from '../../packages/mc-assets/src';
import type { CachedTextureVariableDefinition } from '../services/modelParentChain';
import { workspaceResourceCache } from '../services/workspaceResourceCache';
import { arrayElements, JsonAstNode, memberName, objectMembers, stringValue } from '../utils/jsonAst';
import { isInArea } from '../utils/locationChecker';
import { createTextureVariableDefinitionResolver } from '../utils/modelTexture';
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

  for (const textureReference of getTextureVariableReferences(ast.body)) {
    if (isInArea(line, character, textureReference.loc)) {
      const texture = stringValue(textureReference);
      const definition = texture
        ? textureVariableResolver.resolve(texture)
        : null;
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

function getTextureVariableReferences(modelBody: JsonAstNode): JsonAstNode[] {
  const references: JsonAstNode[] = [];

  for (const member of objectMembers(modelBody)) {
    if (memberName(member) === 'textures') {
      for (const texture of objectMembers(member.value)) {
        pushTextureVariableReference(references, texture.value);
      }
    } else if (memberName(member) === 'elements') {
      for (const element of arrayElements(member.value)) {
        const faces = objectMembers(element).find(face => memberName(face) === 'faces');
        for (const face of objectMembers(faces?.value)) {
          const texture = objectMembers(face.value).find(faceMember => memberName(faceMember) === 'texture');
          pushTextureVariableReference(references, texture?.value);
        }
      }
    }
  }

  return references;
}

function pushTextureVariableReference(references: JsonAstNode[], node: JsonAstNode | null | undefined) {
  if (node && stringValue(node)?.startsWith('#')) {
    references.push(node);
  }
}
