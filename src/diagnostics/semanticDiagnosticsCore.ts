import * as path from "node:path";
import { lm, type LocalizedMessage } from "../i18n/messages";
import {
  getTextResourceIssues,
  type FileResourceIssue,
  type NonJsonIssueSeverity
} from "./nonJsonResourceChecks";
import { findAssetsRoot, parseAssetsPath } from "../../packages/mc-assets/src";
import {
  arrayElements,
  getObjectMember,
  JsonAstNode,
  JsonDocumentNode,
  memberName,
  numberValue,
  objectMembers,
  stringValue
} from "../utils/jsonAst";

export interface SemanticDiagnosticsDocument {
  languageId: string;
  fileName: string;
  getText(): string;
}

export interface SemanticDiagnosticsConfiguration {
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
}

export interface SemanticDiagnosticsModelDocument {
  ast: JsonDocumentNode;
}

export interface SemanticDiagnosticsHost {
  getJsonAst(document: SemanticDiagnosticsDocument): JsonDocumentNode | null;
  readFileBytes(fileName: string): Promise<Uint8Array | undefined>;
  getPackImageResourceIssues(packRoot: string): readonly FileResourceIssue[];
  getModelParentChain(
    document: SemanticDiagnosticsDocument,
    ast: JsonDocumentNode,
    configuration: SemanticDiagnosticsConfiguration
  ): readonly SemanticDiagnosticsModelDocument[];
  getSoundEvents(soundsJsonPath: string): ReadonlySet<string> | null;
}

export interface SemanticDiagnosticsOptions {
  configuration: SemanticDiagnosticsConfiguration;
  localize: (message: LocalizedMessage) => string;
  host: SemanticDiagnosticsHost;
}

export type SemanticDiagnosticSeverity = NonJsonIssueSeverity;

export interface SemanticDiagnosticPosition {
  line: number;
  character: number;
}

export interface SemanticDiagnosticRange {
  start: SemanticDiagnosticPosition;
  end: SemanticDiagnosticPosition;
}

export interface SemanticDiagnostic {
  range: SemanticDiagnosticRange;
  message: LocalizedMessage;
  severity: SemanticDiagnosticSeverity;
}

interface FormatVersion {
  major: number;
  minor: number;
}

interface TextureVariable {
  value: string;
  valueNode: JsonAstNode;
  isCurrentDocument: boolean;
}

const modernPackFormatBoundary = 65;

export function isSemanticDiagnosticsDocument(document: SemanticDiagnosticsDocument): boolean {
  return isTextResourceDocument(document.fileName) ||
    (document.languageId === "json" && (
      /[\\/]pack\.mcmeta$/i.test(document.fileName) ||
      /[\\/]models[\\/].+\.json$/i.test(document.fileName) ||
      /[\\/]post_effect[\\/].+\.json$/i.test(document.fileName) ||
      /[\\/]assets[\\/][^\\/]+[\\/]sounds\.json$/i.test(document.fileName)
    ));
}

export async function getSemanticDiagnostics(
  document: SemanticDiagnosticsDocument,
  options: SemanticDiagnosticsOptions
): Promise<SemanticDiagnostic[]> {
  if (!isSemanticDiagnosticsDocument(document)) {
    return [];
  }

  if (isTextResourceDocument(document.fileName)) {
    return getTextResourceDiagnostics(document, options.host);
  }

  const ast = options.host.getJsonAst(document);
  if (!ast) {
    return [];
  }

  if (/[\\/]pack\.mcmeta$/i.test(document.fileName)) {
    return getPackMcmetaDiagnostics(document, ast, options.localize, options.host);
  }

  if (/[\\/]models[\\/].+\.json$/i.test(document.fileName)) {
    return getModelDiagnostics(document, ast, options.configuration, options.host);
  }

  if (/[\\/]post_effect[\\/].+\.json$/i.test(document.fileName)) {
    return getPostEffectDiagnostics(ast);
  }

  return getSoundDiagnostics(document, ast, options.host);
}

function getPackMcmetaDiagnostics(
  document: SemanticDiagnosticsDocument,
  ast: JsonDocumentNode,
  localize: (message: LocalizedMessage) => string,
  host: SemanticDiagnosticsHost
): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
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
      lm("pack.mcmeta must use min_format and max_format together for 1.21.9+ resource pack formats.")
    );
  }

  if (min && max && compareFormats(min, max) > 0) {
    pushDiagnostic(diagnostics, maxFormat?.value ?? packNode, lm("pack.mcmeta min_format must be less than or equal to max_format."));
  }

  if (min && max) {
    const crossesBoundary = min.major < modernPackFormatBoundary && max.major >= modernPackFormatBoundary;
    const modernOnly = min.major >= modernPackFormatBoundary;
    const legacyOnly = max.major < modernPackFormatBoundary;

    if (modernOnly && (packFormat || supportedFormats)) {
      pushDiagnostic(
        diagnostics,
        (packFormat ?? supportedFormats)?.value ?? packNode,
        lm("Resource packs that only support 1.21.9+ must not use pack_format or supported_formats.")
      );
    }

    if (legacyOnly && !packFormat) {
      pushDiagnostic(diagnostics, packNode, lm("Resource packs that only support 1.21.8 or earlier must use pack_format."));
    }

    if (crossesBoundary) {
      for (const required of [
        ["pack_format", packFormat],
        ["supported_formats", supportedFormats],
        ["min_format", minFormat],
        ["max_format", maxFormat]
      ] as const) {
        if (!required[1]) {
          pushDiagnostic(diagnostics, packNode, lm("Resource packs crossing the 1.21.8 boundary must include {0}.", required[0]));
        }
      }

      const supportedMax = legacyRangeMax(supportedFormats?.value);
      if (supportedFormats && supportedMax !== 64) {
        pushDiagnostic(
          diagnostics,
          supportedFormats.value,
          lm("Resource packs crossing the 1.21.8 boundary must set supported_formats maximum to 64.")
        );
      }
    }
  }

  const packFormatValue = numberValue(packFormat?.value);
  if (packFormatValue !== undefined && packFormatValue >= modernPackFormatBoundary && !minFormat && !maxFormat) {
    pushDiagnostic(diagnostics, packFormat?.value, lm("pack_format is only for resource pack formats before 65; use min_format and max_format."));
  }

  const packRoot = path.dirname(document.fileName);
  for (const issue of host.getPackImageResourceIssues(packRoot)) {
    const relativeFileName = path.relative(packRoot, issue.filePath).replaceAll("\\", "/");
    pushDiagnostic(
      diagnostics,
      ast.body,
      lm("{0}: {1}", relativeFileName, localize(issue.message)),
      issue.severity
    );
  }

  return diagnostics;
}

async function getTextResourceDiagnostics(
  document: SemanticDiagnosticsDocument,
  host: SemanticDiagnosticsHost
): Promise<SemanticDiagnostic[]> {
  const text = document.getText();
  let bytes: Uint8Array | undefined;
  try {
    bytes = await host.readFileBytes(document.fileName);
  } catch {
    bytes = undefined;
  }

  return getTextResourceIssues(document.fileName, text, bytes).map(issue => ({
    range: {
      start: { line: issue.line, character: issue.startCharacter },
      end: { line: issue.line, character: issue.endCharacter }
    },
    message: issue.message,
    severity: issue.severity
  }));
}

function getModelDiagnostics(
  document: SemanticDiagnosticsDocument,
  ast: JsonDocumentNode,
  configuration: SemanticDiagnosticsConfiguration,
  host: SemanticDiagnosticsHost
): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const parent = getObjectMember(ast.body, "parent");
  const chain = host.getModelParentChain(document, ast, configuration);

  if (chain.length > 11) {
    pushDiagnostic(diagnostics, parent?.value ?? ast.body, lm("Model parent chain exceeds Minecraft's maximum depth of 10."));
  }

  diagnostics.push(...getTextureVariableCycleDiagnostics(chain));
  return diagnostics;
}

function getPostEffectDiagnostics(ast: JsonDocumentNode): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
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
      pushDiagnostic(diagnostics, output?.value, lm("Post effect output target '{0}' is not declared in targets.", outputName));
    }

    const inputs = getObjectMember(pass, "inputs");
    for (const input of arrayElements(inputs?.value)) {
      const target = getObjectMember(input, "target");
      const targetName = stringValue(target?.value);
      if (!targetName) {
        continue;
      }

      if (!declaredTargets.has(targetName)) {
        pushDiagnostic(diagnostics, target?.value, lm("Post effect input target '{0}' is not declared in targets.", targetName));
      }

      if (outputName && targetName === outputName) {
        pushDiagnostic(diagnostics, target?.value, lm("Post effect pass input target must not be the same as its output target."));
      }
    }
  }

  return diagnostics;
}

function getSoundDiagnostics(
  document: SemanticDiagnosticsDocument,
  ast: JsonDocumentNode,
  host: SemanticDiagnosticsHost
): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const currentNamespace = parseAssetsPath(document.fileName)?.namespace ?? null;
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
        pushSoundEventReferenceDiagnostics(diagnostics, document, currentNamespace, eventNames, soundName, name?.value, host);
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
            lm("Invalid sounds[].{0}; Minecraft ignores the whole sounds.json when name, volume, or pitch is invalid.", numericField)
          );
        }
      }
    }
  }

  return diagnostics;
}

function pushSoundFileDiagnostics(diagnostics: SemanticDiagnostic[], value: string, node: JsonAstNode | null | undefined): void {
  if (/\s/.test(value)) {
    pushDiagnostic(diagnostics, node, lm("Sound file names must not contain whitespace; Minecraft may ignore the whole sounds.json."));
  }

  if (/\.ogg$/i.test(value)) {
    pushDiagnostic(diagnostics, node, lm("Sound file references should omit the .ogg extension."));
  }
}

function pushSoundEventReferenceDiagnostics(
  diagnostics: SemanticDiagnostic[],
  document: SemanticDiagnosticsDocument,
  currentNamespace: string | null,
  localEvents: Set<string>,
  value: string,
  node: JsonAstNode | null | undefined,
  host: SemanticDiagnosticsHost
): void {
  const location = parseNamespacedValue(value, currentNamespace);
  if (!location) {
    return;
  }

  const availableEvents = location.namespace === currentNamespace
    ? localEvents
    : loadSoundEventsForNamespace(document.fileName, location.namespace, host);

  if (availableEvents && !availableEvents.has(location.path)) {
    pushDiagnostic(diagnostics, node, lm("Sound event '{0}' is not defined in sounds.json.", value));
  }
}

function loadSoundEventsForNamespace(
  fileName: string,
  namespace: string,
  host: SemanticDiagnosticsHost
): ReadonlySet<string> | null {
  const assetsRoot = findAssetsRoot(fileName, "sounds.json");
  const soundsJsonPath = assetsRoot ? path.join(assetsRoot, namespace, "sounds.json") : null;
  return soundsJsonPath ? host.getSoundEvents(soundsJsonPath) : null;
}

function getTextureVariableCycleDiagnostics(chain: readonly SemanticDiagnosticsModelDocument[]): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
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
        pushDiagnostic(diagnostics, variable.valueNode, lm("Texture variable '{0}' contains a cyclic # reference chain.", name));
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

function pushDiagnostic(
  diagnostics: SemanticDiagnostic[],
  node: JsonAstNode | null | undefined,
  message: LocalizedMessage,
  severity: SemanticDiagnosticSeverity = "warning"
): void {
  const range = rangeFromNode(node);
  if (range) {
    diagnostics.push({ range, message, severity });
  }
}

function rangeFromNode(node: JsonAstNode | null | undefined): SemanticDiagnosticRange | null {
  if (!node?.loc) {
    return null;
  }

  return {
    start: { line: node.loc.start.line - 1, character: node.loc.start.column - 1 },
    end: { line: node.loc.end.line - 1, character: node.loc.end.column - 1 }
  };
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

function isTextResourceDocument(fileName: string): boolean {
  return /[\\/]assets[\\/][^\\/]+[\\/]texts[\\/](?:splashes|end|postcredits)\.txt$/i.test(fileName);
}
