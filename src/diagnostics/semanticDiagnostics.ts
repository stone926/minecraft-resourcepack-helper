import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { generateRedirectPath } from "../utils/pathGenerator";
import { findAssetsRoot } from "../utils/resourceLocation";
import {
  arrayElements,
  JsonAstNode,
  JsonDocumentNode,
  JsonMemberNode,
  memberName,
  numberValue,
  objectMembers,
  parseJsonAst,
  stringValue
} from "../utils/jsonAst";
import { modelSourceForFile } from "../utils/modelTexture";

interface SemanticDiagnosticsDocument {
  languageId: string;
  fileName: string;
  getText(): string;
}

interface FormatVersion {
  major: number;
  minor: number;
}

interface LoadedModel {
  ast: JsonDocumentNode;
  fileName: string;
  source: string;
}

interface TextureVariable {
  value: string;
  valueNode: JsonAstNode;
  isCurrentDocument: boolean;
}

const modernPackFormatBoundary = 65;

export function isSemanticDiagnosticsDocument(document: SemanticDiagnosticsDocument): boolean {
  return document.languageId === "json" && (
    /[\\/]pack\.mcmeta$/i.test(document.fileName) ||
    /[\\/]models[\\/].+\.json$/i.test(document.fileName) ||
    /[\\/]post_effect[\\/].+\.json$/i.test(document.fileName) ||
    /[\\/]assets[\\/][^\\/]+[\\/]sounds\.json$/i.test(document.fileName)
  );
}

export function getSemanticResourceDiagnostics(document: SemanticDiagnosticsDocument): vscode.Diagnostic[] {
  if (!isSemanticDiagnosticsDocument(document)) {
    return [];
  }

  const ast = parseJsonAst(document.getText());
  if (!ast) {
    return [];
  }

  if (/[\\/]pack\.mcmeta$/i.test(document.fileName)) {
    return getPackMcmetaDiagnostics(ast);
  }

  if (/[\\/]models[\\/].+\.json$/i.test(document.fileName)) {
    return getModelDiagnostics(document, ast);
  }

  if (/[\\/]post_effect[\\/].+\.json$/i.test(document.fileName)) {
    return getPostEffectDiagnostics(ast);
  }

  return getSoundDiagnostics(document, ast);
}

function getPackMcmetaDiagnostics(ast: JsonDocumentNode): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const pack = getObjectMember(ast.body, "pack");
  const packNode = pack?.value ?? ast.body;
  const minFormat = getObjectMember(packNode, "min_format");
  const maxFormat = getObjectMember(packNode, "max_format");
  const packFormat = getObjectMember(packNode, "pack_format");
  const supportedFormats = getObjectMember(packNode, "supported_formats");
  const min = formatFromNode(minFormat?.value, false);
  const max = formatFromNode(maxFormat?.value, true);

  if ((minFormat && !maxFormat) || (!minFormat && maxFormat)) {
    pushDiagnostic(
      diagnostics,
      (minFormat ?? maxFormat)?.value ?? packNode,
      "pack.mcmeta must use min_format and max_format together for 1.21.9+ resource pack formats."
    );
  }

  if (min && max && compareFormats(min, max) > 0) {
    pushDiagnostic(diagnostics, maxFormat?.value ?? packNode, "pack.mcmeta min_format must be less than or equal to max_format.");
  }

  if (min && max) {
    const crossesBoundary = min.major < modernPackFormatBoundary && max.major >= modernPackFormatBoundary;
    const modernOnly = min.major >= modernPackFormatBoundary;
    const legacyOnly = max.major < modernPackFormatBoundary;

    if (modernOnly && (packFormat || supportedFormats)) {
      pushDiagnostic(
        diagnostics,
        (packFormat ?? supportedFormats)?.value ?? packNode,
        "Resource packs that only support 1.21.9+ must not use pack_format or supported_formats."
      );
    }

    if (legacyOnly && !packFormat) {
      pushDiagnostic(diagnostics, packNode, "Resource packs that only support 1.21.8 or earlier must use pack_format.");
    }

    if (crossesBoundary) {
      for (const required of [
        ["pack_format", packFormat],
        ["supported_formats", supportedFormats],
        ["min_format", minFormat],
        ["max_format", maxFormat]
      ] as const) {
        if (!required[1]) {
          pushDiagnostic(diagnostics, packNode, `Resource packs crossing the 1.21.8 boundary must include ${required[0]}.`);
        }
      }

      const supportedMax = legacyRangeMax(supportedFormats?.value);
      if (supportedFormats && supportedMax !== 64) {
        pushDiagnostic(
          diagnostics,
          supportedFormats.value,
          "Resource packs crossing the 1.21.8 boundary must set supported_formats maximum to 64."
        );
      }
    }
  }

  const packFormatValue = numberValue(packFormat?.value);
  if (packFormatValue !== undefined && packFormatValue >= modernPackFormatBoundary && !minFormat && !maxFormat) {
    pushDiagnostic(diagnostics, packFormat?.value, "pack_format is only for resource pack formats before 65; use min_format and max_format.");
  }

  return diagnostics;
}

function getModelDiagnostics(document: SemanticDiagnosticsDocument, ast: JsonDocumentNode): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const parent = getObjectMember(ast.body, "parent");
  const chain = loadModelChain(document, ast);

  if (chain.length > 11) {
    pushDiagnostic(diagnostics, parent?.value ?? ast.body, "Model parent chain exceeds Minecraft's maximum depth of 10.");
  }

  diagnostics.push(...getTextureVariableCycleDiagnostics(chain));
  return diagnostics;
}

function getPostEffectDiagnostics(ast: JsonDocumentNode): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const declaredTargets = new Set(["minecraft:main", "main"]);
  const targets = getObjectMember(ast.body, "targets");

  for (const target of objectMembers(targets?.value)) {
    const name = memberName(target);
    if (name) {
      declaredTargets.add(name);
    }
  }

  const passes = getObjectMember(ast.body, "passes");
  for (const pass of arrayElements(passes?.value)) {
    const output = getObjectMember(pass, "output");
    const outputName = stringValue(output?.value);

    if (outputName && !declaredTargets.has(outputName)) {
      pushDiagnostic(diagnostics, output?.value, `Post effect output target '${outputName}' is not declared in targets.`);
    }

    const inputs = getObjectMember(pass, "inputs");
    for (const input of arrayElements(inputs?.value)) {
      const target = getObjectMember(input, "target");
      const targetName = stringValue(target?.value);
      if (!targetName) {
        continue;
      }

      if (!declaredTargets.has(targetName)) {
        pushDiagnostic(diagnostics, target?.value, `Post effect input target '${targetName}' is not declared in targets.`);
      }

      if (outputName && targetName === outputName) {
        pushDiagnostic(diagnostics, target?.value, "Post effect pass input target must not be the same as its output target.");
      }
    }
  }

  return diagnostics;
}

function getSoundDiagnostics(document: SemanticDiagnosticsDocument, ast: JsonDocumentNode): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const currentNamespace = namespaceFromSoundsFile(document.fileName);
  const eventNames = new Set(objectMembers(ast.body).map(member => memberName(member)).filter((name): name is string => Boolean(name)));

  for (const soundEvent of objectMembers(ast.body)) {
    const sounds = getObjectMember(soundEvent.value, "sounds");
    for (const sound of arrayElements(sounds?.value)) {
      const directSound = stringValue(sound);
      if (directSound !== undefined) {
        pushSoundFileDiagnostics(diagnostics, directSound, sound);
        continue;
      }

      const type = stringValue(getObjectMember(sound, "type")?.value);
      const name = getObjectMember(sound, "name");
      const soundName = stringValue(name?.value);
      if (type === "event" && soundName) {
        pushSoundEventReferenceDiagnostics(diagnostics, document, currentNamespace, eventNames, soundName, name?.value);
      } else if (soundName) {
        pushSoundFileDiagnostics(diagnostics, soundName, name?.value);
      }

      for (const numericField of ["volume", "pitch"]) {
        const field = getObjectMember(sound, numericField);
        const value = numberValue(field?.value);
        if (value !== undefined && value <= 0) {
          pushDiagnostic(
            diagnostics,
            field?.value,
            `Invalid sounds[].${numericField}; Minecraft ignores the whole sounds.json when name, volume, or pitch is invalid.`
          );
        }
      }
    }
  }

  return diagnostics;
}

function pushSoundFileDiagnostics(diagnostics: vscode.Diagnostic[], value: string, node: JsonAstNode | null | undefined): void {
  if (/\s/.test(value)) {
    pushDiagnostic(diagnostics, node, "Sound file names must not contain whitespace; Minecraft may ignore the whole sounds.json.");
  }

  if (/\.ogg$/i.test(value)) {
    pushDiagnostic(diagnostics, node, "Sound file references should omit the .ogg extension.");
  }
}

function pushSoundEventReferenceDiagnostics(
  diagnostics: vscode.Diagnostic[],
  document: SemanticDiagnosticsDocument,
  currentNamespace: string | null,
  localEvents: Set<string>,
  value: string,
  node: JsonAstNode | null | undefined
): void {
  const location = parseNamespacedValue(value, currentNamespace);
  if (!location) {
    return;
  }

  const availableEvents = location.namespace === currentNamespace
    ? localEvents
    : loadSoundEventsForNamespace(document.fileName, location.namespace);

  if (availableEvents && !availableEvents.has(location.path)) {
    pushDiagnostic(diagnostics, node, `Sound event '${value}' is not defined in sounds.json.`);
  }
}

function loadSoundEventsForNamespace(fileName: string, namespace: string): Set<string> | null {
  const assetsRoot = findAssetsRoot(fileName, "sounds.json");
  const soundsJsonPath = assetsRoot ? path.join(assetsRoot, namespace, "sounds.json") : null;
  if (!soundsJsonPath || !fs.existsSync(soundsJsonPath)) {
    return null;
  }

  try {
    const ast = parseJsonAst(fs.readFileSync(soundsJsonPath, "utf8"));
    return ast ? new Set(objectMembers(ast.body).map(member => memberName(member)).filter((name): name is string => Boolean(name))) : null;
  } catch {
    return null;
  }
}

function loadModelChain(document: SemanticDiagnosticsDocument, ast: JsonDocumentNode): LoadedModel[] {
  const models: LoadedModel[] = [{
    ast,
    fileName: document.fileName,
    source: modelSourceForFile(document.fileName)
  }];
  const visited = new Set([pathKey(document.fileName)]);

  while (models.length <= 11) {
    const current = models[models.length - 1];
    const parent = stringValue(getObjectMember(current.ast.body, "parent")?.value);
    if (!parent) {
      break;
    }

    const parentUri = generateRedirectPath(parent, { fileName: current.fileName }, "models", current.source, "json");
    if (!parentUri) {
      break;
    }

    const key = pathKey(parentUri.fsPath);
    if (visited.has(key)) {
      break;
    }
    visited.add(key);

    try {
      const parentAst = parseJsonAst(fs.readFileSync(parentUri.fsPath, "utf8"));
      if (!parentAst) {
        break;
      }
      models.push({
        ast: parentAst,
        fileName: parentUri.fsPath,
        source: modelSourceForFile(parentUri.fsPath)
      });
    } catch {
      break;
    }
  }

  return models;
}

function getTextureVariableCycleDiagnostics(chain: LoadedModel[]): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const variables = new Map<string, TextureVariable>();

  chain.forEach((model, index) => {
    const textures = getObjectMember(model.ast.body, "textures");
    for (const texture of objectMembers(textures?.value)) {
      const name = memberName(texture);
      const value = stringValue(texture.value);
      if (name && value && !variables.has(name)) {
        variables.set(name, {
          value,
          valueNode: texture.value,
          isCurrentDocument: index === 0
        });
      }
    }
  });

  for (const [name, variable] of variables) {
    if (!variable.isCurrentDocument || !variable.value.startsWith("#")) {
      continue;
    }

    const visited = new Set<string>();
    let currentName = name;
    while (true) {
      if (visited.has(currentName)) {
        pushDiagnostic(diagnostics, variable.valueNode, `Texture variable '${name}' contains a cyclic # reference chain.`);
        break;
      }
      visited.add(currentName);

      const current = variables.get(currentName);
      if (!current?.value.startsWith("#")) {
        break;
      }

      currentName = current.value.slice(1);
    }
  }

  return diagnostics;
}

function formatFromNode(node: JsonAstNode | null | undefined, isMaxFormat: boolean): FormatVersion | null {
  const number = numberValue(node);
  if (typeof number === "number" && Number.isInteger(number) && number >= 0) {
    return {
      major: number,
      minor: isMaxFormat ? Number.MAX_SAFE_INTEGER : 0
    };
  }

  const values = arrayElements(node).map(element => numberValue(element));
  if (values.length < 1 || values.length > 2 || values.some(value => value === undefined || value < 0 || !Number.isInteger(value))) {
    return null;
  }

  return {
    major: values[0] ?? 0,
    minor: values[1] ?? (isMaxFormat ? Number.MAX_SAFE_INTEGER : 0)
  };
}

function legacyRangeMax(node: JsonAstNode | null | undefined): number | null {
  const number = numberValue(node);
  if (number !== undefined) {
    return number;
  }

  const values = arrayElements(node).map(element => numberValue(element));
  if (values.length === 2 && values.every(value => value !== undefined)) {
    return values[1] ?? null;
  }

  return numberValue(getObjectMember(node, "max_inclusive")?.value) ?? null;
}

function compareFormats(left: FormatVersion, right: FormatVersion): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }

  return left.minor - right.minor;
}

function getObjectMember(node: JsonAstNode | null | undefined, name: string): JsonMemberNode | null {
  return objectMembers(node).find(member => memberName(member) === name) ?? null;
}

function pushDiagnostic(diagnostics: vscode.Diagnostic[], node: JsonAstNode | null | undefined, message: string): void {
  const range = rangeFromNode(node);
  if (range) {
    diagnostics.push(new vscode.Diagnostic(range, vscode.l10n.t(message), vscode.DiagnosticSeverity.Warning));
  }
}

function rangeFromNode(node: JsonAstNode | null | undefined): vscode.Range | null {
  if (!node?.loc) {
    return null;
  }

  return new vscode.Range(
    new vscode.Position(node.loc.start.line - 1, node.loc.start.column - 1),
    new vscode.Position(node.loc.end.line - 1, node.loc.end.column - 1)
  );
}

function parseNamespacedValue(value: string, defaultNamespace: string | null): { namespace: string; path: string } | null {
  const separator = value.indexOf(":");
  if (separator >= 0) {
    return {
      namespace: value.slice(0, separator),
      path: value.slice(separator + 1)
    };
  }

  return defaultNamespace ? { namespace: defaultNamespace, path: value } : null;
}

function namespaceFromSoundsFile(fileName: string): string | null {
  const normalized = path.normalize(fileName);
  const segments = normalized.split(path.sep);
  const assetsIndex = findLastIndex(segments, segment => segment.toLowerCase() === "assets");
  return assetsIndex >= 0 && segments.length > assetsIndex + 1 ? segments[assetsIndex + 1] : null;
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index--) {
    if (predicate(values[index])) {
      return index;
    }
  }

  return -1;
}

function pathKey(fileName: string): string {
  const normalized = path.normalize(fileName);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
