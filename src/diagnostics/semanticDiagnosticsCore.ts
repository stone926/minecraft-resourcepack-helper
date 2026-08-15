import * as path from "node:path";
import { lm, type LocalizedMessage } from "../i18n/messages";
import { getTextResourceFileKind } from "../resources/resourceSurfaceRegistry";
import type { ModelParentTraversalIssue } from "../services/modelParentTraversal";
import {
  getTextResourceIssues,
  type FileResourceIssue,
  type NonJsonIssueSeverity
} from "./nonJsonResourceChecks";
import type { SoundEventFileGraph, SoundEventGraphEdge } from "./soundEventGraph";
import { parseMinecraftResourceId, findAssetsRoot, parseAssetsPath } from "../../packages/mc-assets/src";
import { jsonAstLocationToLineCharacterRange } from "../utils/astLocationRanges";
import {
  builtinMinecraftAtlasNames,
  getResourceSemanticDiagnosticsKind,
  type ResourceSemanticDiagnosticsKind
} from "../resources/resourceSurfaceRegistry";
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

export interface SemanticDiagnosticsModelParentChain {
  models: readonly SemanticDiagnosticsModelDocument[];
  issue: ModelParentTraversalIssue | null;
}

export interface SemanticDiagnosticsHost {
  getJsonAst(document: SemanticDiagnosticsDocument): JsonDocumentNode | null;
  readFileBytes(fileName: string): Promise<Uint8Array | undefined>;
  getPackImageResourceIssues(packRoot: string): readonly FileResourceIssue[];
  getModelParentChain(
    document: SemanticDiagnosticsDocument,
    ast: JsonDocumentNode,
    configuration: SemanticDiagnosticsConfiguration
  ): Promise<SemanticDiagnosticsModelParentChain> | SemanticDiagnosticsModelParentChain;
  getSoundEventGraph(
    soundsJsonPath: string
  ): Promise<SoundEventFileGraph | null> | SoundEventFileGraph | null;
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
const builtinPostEffectInputTargets = new Set([
  "minecraft:main",
  "minecraft:translucent",
  "minecraft:item_entity",
  "minecraft:particles",
  "minecraft:weather",
  "minecraft:clouds",
  "minecraft:entity_outline"
]);
const builtinMinecraftAtlasNameSet = new Set<string>(builtinMinecraftAtlasNames);

type SemanticDiagnosticsHandler = (
  document: SemanticDiagnosticsDocument,
  ast: JsonDocumentNode,
  options: SemanticDiagnosticsOptions
) => Promise<SemanticDiagnostic[]> | SemanticDiagnostic[];

const semanticDiagnosticsHandlers = {
  atlas: (document, ast) => getAtlasDiagnostics(document, ast),
  packMetadata: (document, ast, options) =>
    getPackMcmetaDiagnostics(document, ast, options.localize, options.host),
  model: (document, ast, options) =>
    getModelDiagnostics(document, ast, options.configuration, options.host),
  postEffect: (_document, ast) => getPostEffectDiagnostics(ast),
  sounds: (document, ast, options) => getSoundDiagnostics(document, ast, options.host),
  textureMetadata: (_document, ast) => getTextureMetadataDiagnostics(ast),
  waypointStyle: (_document, ast) => getWaypointStyleDiagnostics(ast)
} satisfies Record<ResourceSemanticDiagnosticsKind, SemanticDiagnosticsHandler>;

export const semanticDiagnosticsHandlerKinds: readonly ResourceSemanticDiagnosticsKind[] = Object.freeze(
  Object.keys(semanticDiagnosticsHandlers) as ResourceSemanticDiagnosticsKind[]
);

export function isSemanticDiagnosticsDocument(document: SemanticDiagnosticsDocument): boolean {
  return isTextResourceDocument(document.fileName) ||
    getResourceSemanticDiagnosticsKind(document.fileName, document.languageId) !== null;
}

export async function getSemanticDiagnostics(
  document: SemanticDiagnosticsDocument,
  options: SemanticDiagnosticsOptions
): Promise<SemanticDiagnostic[]> {
  if (isTextResourceDocument(document.fileName)) {
    return getTextResourceDiagnostics(document, options.host);
  }

  const diagnosticsKind = getResourceSemanticDiagnosticsKind(document.fileName, document.languageId);
  if (!diagnosticsKind) {
    return [];
  }

  const ast = options.host.getJsonAst(document);
  if (!ast) {
    return [];
  }

  return semanticDiagnosticsHandlers[diagnosticsKind](document, ast, options);
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
    const modernOnly = min.major >= modernPackFormatBoundary;
    const includesLegacyFormats = min.major < modernPackFormatBoundary;

    if (modernOnly && supportedFormats) {
      pushDiagnostic(
        diagnostics,
        supportedFormats.value,
        lm("Resource packs that only support 1.21.9+ must not use supported_formats.")
      );
    }

    if (includesLegacyFormats) {
      for (const required of [["pack_format", packFormat], ["supported_formats", supportedFormats]] as const) {
        if (!required[1]) {
          pushDiagnostic(
            diagnostics,
            packNode,
            lm("Resource pack ranges that include format 64 or earlier must include {0}.", required[0])
          );
        }
      }

      const supportedRange = legacyRangeFromNode(supportedFormats?.value);
      if (supportedFormats && supportedRange && (
        supportedRange.min !== min.major
        || supportedRange.max !== max.major
      )) {
        pushDiagnostic(
          diagnostics,
          supportedFormats.value,
          lm("supported_formats bounds must match the min_format and max_format major versions.")
        );
      }
      const packFormatValue = numberValue(packFormat?.value);
      if (
        supportedRange
        && packFormatValue !== undefined
        && (packFormatValue < supportedRange.min || packFormatValue > supportedRange.max)
      ) {
        pushDiagnostic(
          diagnostics,
          packFormat?.value,
          lm("pack_format must be included in the supported_formats range.")
        );
      }
    }
  }

  const packFormatValue = numberValue(packFormat?.value);
  if (packFormatValue !== undefined && packFormatValue >= modernPackFormatBoundary && !minFormat && !maxFormat) {
    pushDiagnostic(
      diagnostics,
      packNode,
      lm("pack.mcmeta must use min_format and max_format together for 1.21.9+ resource pack formats.")
    );
  }

  validateOverlayFormatBoundaries(ast.body, diagnostics);

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

function validateOverlayFormatBoundaries(
  root: JsonAstNode,
  diagnostics: SemanticDiagnostic[]
): void {
  const overlays = getObjectMember(root, "overlays");
  const entries = arrayElements(getObjectMember(overlays?.value, "entries")?.value).map(node => {
    const minMember = getObjectMember(node, "min_format");
    const maxMember = getObjectMember(node, "max_format");
    const formatsMember = getObjectMember(node, "formats");
    return {
      node,
      min: formatFromNode(minMember?.value, false),
      max: formatFromNode(maxMember?.value, true),
      formatsMember,
      legacyRange: legacyRangeFromNode(formatsMember?.value)
    };
  });
  if (entries.length === 0) {
    return;
  }

  const includesLegacyFormats = entries.some(entry =>
    entry.min?.major !== undefined
      ? entry.min.major < modernPackFormatBoundary
      : (entry.legacyRange?.min ?? modernPackFormatBoundary) < modernPackFormatBoundary
  );
  for (const entry of entries) {
    if (includesLegacyFormats && !entry.formatsMember) {
      pushDiagnostic(
        diagnostics,
        entry.node,
        lm("When any overlay supports format 64 or earlier, every overlay entry must include formats.")
      );
    } else if (!includesLegacyFormats && entry.formatsMember) {
      pushDiagnostic(
        diagnostics,
        entry.formatsMember.value,
        lm("Overlay entries must omit formats when all overlays support format 65 or newer.")
      );
    }

    if (
      entry.min
      && entry.max
      && entry.legacyRange
      && (
        entry.legacyRange.min !== entry.min.major
        || entry.legacyRange.max !== entry.max.major
      )
    ) {
      pushDiagnostic(
        diagnostics,
        entry.formatsMember?.value ?? entry.node,
        lm("Overlay formats bounds must match the min_format and max_format major versions.")
      );
    }
  }
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

async function getModelDiagnostics(
  document: SemanticDiagnosticsDocument,
  ast: JsonDocumentNode,
  configuration: SemanticDiagnosticsConfiguration,
  host: SemanticDiagnosticsHost
): Promise<SemanticDiagnostic[]> {
  const diagnostics: SemanticDiagnostic[] = [];
  const parent = getObjectMember(ast.body, "parent");
  const chain = await host.getModelParentChain(document, ast, configuration);

  if (chain.issue?.kind === "depth") {
    pushDiagnostic(diagnostics, parent?.value ?? ast.body, lm("Model parent chain exceeds Minecraft's maximum depth of 10."));
  } else if (chain.issue?.kind === "cycle") {
    pushDiagnostic(diagnostics, parent?.value ?? ast.body, lm("Model parent chain contains a cyclic parent reference."));
  }

  diagnostics.push(...getTextureVariableCycleDiagnostics(chain.models));
  return diagnostics;
}

function getPostEffectDiagnostics(ast: JsonDocumentNode): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const declaredTargets = new Set<string>();
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

    if (outputName && outputName !== "minecraft:main") {
      if (builtinPostEffectInputTargets.has(outputName)) {
        pushDiagnostic(diagnostics, output?.value, lm("Post effect output target '{0}' is a read-only builtin target.", outputName));
      } else if (!declaredTargets.has(outputName)) {
        pushDiagnostic(diagnostics, output?.value, lm("Post effect output target '{0}' is not declared in targets.", outputName));
      }
    }

    const inputs = getObjectMember(pass, "inputs");
    for (const input of arrayElements(inputs?.value)) {
      const target = getObjectMember(input, "target");
      const targetName = stringValue(target?.value);
      if (!targetName) {
        continue;
      }

      if (!builtinPostEffectInputTargets.has(targetName) && !declaredTargets.has(targetName)) {
        pushDiagnostic(diagnostics, target?.value, lm("Post effect input target '{0}' is not declared in targets.", targetName));
      }

      if (outputName && targetName === outputName) {
        pushDiagnostic(diagnostics, target?.value, lm("Post effect pass input target must not be the same as its output target."));
      }
    }
  }

  return diagnostics;
}

function getAtlasDiagnostics(
  document: SemanticDiagnosticsDocument,
  ast: JsonDocumentNode
): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const namespace = parseAssetsPath(document.fileName)?.namespace;
  const atlasName = path.basename(document.fileName, ".json");

  if (namespace && namespace !== "minecraft") {
    pushDiagnostic(
      diagnostics,
      ast.body,
      lm("Atlas definitions are only loaded from the minecraft namespace.")
    );
  }
  if (!builtinMinecraftAtlasNameSet.has(atlasName)) {
    pushDiagnostic(
      diagnostics,
      ast.body,
      lm("Atlas '{0}' is not a built-in atlas registered by Minecraft 26.2.", atlasName)
    );
  }
  return diagnostics;
}

function getTextureMetadataDiagnostics(ast: JsonDocumentNode): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const gui = getObjectMember(ast.body, "gui");
  const scaling = getObjectMember(gui?.value, "scaling");
  if (stringValue(getObjectMember(scaling?.value, "type")?.value) !== "nine_slice") {
    return diagnostics;
  }

  const width = numberValue(getObjectMember(scaling?.value, "width")?.value);
  const height = numberValue(getObjectMember(scaling?.value, "height")?.value);
  const border = getObjectMember(scaling?.value, "border");
  const uniformBorder = numberValue(border?.value);
  const left = uniformBorder ?? numberValue(getObjectMember(border?.value, "left")?.value) ?? 0;
  const right = uniformBorder ?? numberValue(getObjectMember(border?.value, "right")?.value) ?? 0;
  const top = uniformBorder ?? numberValue(getObjectMember(border?.value, "top")?.value) ?? 0;
  const bottom = uniformBorder ?? numberValue(getObjectMember(border?.value, "bottom")?.value) ?? 0;

  if (width !== undefined && left + right >= width) {
    pushDiagnostic(diagnostics, border?.value ?? scaling?.value, lm("Nine-slice left and right borders must add up to less than width."));
  }
  if (height !== undefined && top + bottom >= height) {
    pushDiagnostic(diagnostics, border?.value ?? scaling?.value, lm("Nine-slice top and bottom borders must add up to less than height."));
  }
  return diagnostics;
}

function getWaypointStyleDiagnostics(ast: JsonDocumentNode): SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const nearDistance = getObjectMember(ast.body, "near_distance");
  const farDistance = getObjectMember(ast.body, "far_distance");
  const near = nearDistance ? numberValue(nearDistance.value) : 128;
  const far = farDistance ? numberValue(farDistance.value) : 332;
  if (near !== undefined && far !== undefined && far <= near) {
    pushDiagnostic(
      diagnostics,
      farDistance?.value ?? nearDistance?.value ?? ast.body,
      lm("Waypoint far_distance must be greater than near_distance.")
    );
  }
  return diagnostics;
}

async function getSoundDiagnostics(
  document: SemanticDiagnosticsDocument,
  ast: JsonDocumentNode,
  host: SemanticDiagnosticsHost
): Promise<SemanticDiagnostic[]> {
  const diagnostics: SemanticDiagnostic[] = [];
  const currentNamespace = parseAssetsPath(document.fileName)?.namespace ?? null;
  const { buildSoundEventFileGraph, findCyclicSoundEventEdges } = await import("./soundEventGraph.js");
  const currentGraph = currentNamespace
    ? buildSoundEventFileGraph(ast, currentNamespace)
    : null;

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
      if (type !== "event" && soundName) {
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

  if (currentGraph) {
    const reachableGraph = await loadReachableSoundEventGraph(document.fileName, currentGraph, host);
    for (const reference of currentGraph.edges) {
      const targetGraph = reachableGraph.graphsByNamespace.get(reference.targetNamespace);
      if (targetGraph && !targetGraph.eventNames.has(reference.targetPath)) {
        pushDiagnostic(
          diagnostics,
          reference.node,
          lm("Sound event '{0}' is not defined in sounds.json.", reference.value)
        );
      }
    }

    const cyclicReferences = findCyclicSoundEventEdges(reachableGraph.edges);
    for (const reference of currentGraph.edges) {
      if (cyclicReferences.has(reference)) {
        pushDiagnostic(
          diagnostics,
          reference.node,
          lm("Sound event '{0}' directly or indirectly references itself.", reference.value)
        );
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

interface ReachableSoundEventGraph {
  graphsByNamespace: ReadonlyMap<string, SoundEventFileGraph | null>;
  edges: readonly SoundEventGraphEdge[];
}

async function loadReachableSoundEventGraph(
  fileName: string,
  currentGraph: SoundEventFileGraph,
  host: SemanticDiagnosticsHost
): Promise<ReachableSoundEventGraph> {
  const assetsRoot = findAssetsRoot(fileName, "sounds.json");
  const graphsByNamespace = new Map<string, SoundEventFileGraph | null>([
    [currentGraph.namespace, currentGraph]
  ]);
  const edges: SoundEventGraphEdge[] = [];
  const pendingEventIds = [...currentGraph.eventIds];
  const visitedEventIds = new Set<string>();

  for (let index = 0; index < pendingEventIds.length; index++) {
    const eventId = pendingEventIds[index];
    if (!eventId || visitedEventIds.has(eventId)) {
      continue;
    }
    visitedEventIds.add(eventId);

    const location = parseMinecraftResourceId(eventId);
    if (!location.isValid) {
      continue;
    }

    if (!graphsByNamespace.has(location.namespace)) {
      let graph: SoundEventFileGraph | null = null;
      if (assetsRoot) {
        try {
          graph = await host.getSoundEventGraph(
            path.join(assetsRoot, location.namespace, "sounds.json")
          );
        } catch {
          graph = null;
        }
      }
      graphsByNamespace.set(location.namespace, graph);
    }

    const graph = graphsByNamespace.get(location.namespace);
    for (const edge of graph?.edgesBySource.get(eventId) ?? []) {
      edges.push(edge);
      if (!visitedEventIds.has(edge.targetId)) {
        pendingEventIds.push(edge.targetId);
      }
    }
  }

  return { graphsByNamespace, edges };
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

function legacyRangeFromNode(
  node: JsonAstNode | null | undefined
): { min: number; max: number } | null {
  const number = numberValue(node);
  if (number !== undefined && Number.isInteger(number) && number > 0) {
    return { min: number, max: number };
  }

  const values = arrayElements(node).map(element => numberValue(element));
  if (
    values.length === 2
    && values.every(value => value !== undefined && Number.isInteger(value) && value > 0)
    && values[0]! <= values[1]!
  ) {
    return { min: values[0]!, max: values[1]! };
  }

  const min = numberValue(getObjectMember(node, "min_inclusive")?.value);
  const max = numberValue(getObjectMember(node, "max_inclusive")?.value);
  return min !== undefined
    && max !== undefined
    && Number.isInteger(min)
    && Number.isInteger(max)
    && min > 0
    && min <= max
    ? { min, max }
    : null;
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
  return jsonAstLocationToLineCharacterRange(node.loc);
}

function isTextResourceDocument(fileName: string): boolean {
  return getTextResourceFileKind(fileName) !== null;
}
