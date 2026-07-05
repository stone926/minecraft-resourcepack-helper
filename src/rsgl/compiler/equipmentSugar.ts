import { EquipmentLayerStmtNode, TextRange } from "../parser";
import { EvaluationContext, evaluateExpression } from "./evaluate";
import { JsonValue } from "./ir";
import { ResourceBodyFragment } from "./resourceBody";
import { appendGeneratedPath } from "./sourcePaths";

export interface EquipmentSugarOptions {
  onError?: (code: string, message: string, range: TextRange) => void;
}

export interface EquipmentBodySugarResult {
  content: Record<string, JsonValue>;
  compactLayers: boolean;
}

export function compileEquipmentLayerStatement(
  statement: EquipmentLayerStmtNode,
  context: EvaluationContext,
  options: EquipmentSugarOptions = {}
): ResourceBodyFragment | undefined {
  const layer = evaluateExpression(statement.layer, context);
  if (typeof layer !== "string" || layer.length === 0) {
    options.onError?.("rsgl.invalidEquipmentLayer", "Equipment layer name must evaluate to a non-empty string.", statement.layer.range);
    return undefined;
  }

  const texture = statement.texture ? evaluateExpression(statement.texture, context) : undefined;
  if (typeof texture !== "string" || texture.length === 0) {
    options.onError?.("rsgl.invalidEquipmentLayerTexture", "Equipment layer statement requires a non-empty texture id.", statement.range);
    return undefined;
  }

  const entry = createEquipmentLayerEntry(
    texture,
    context,
    {
      dyeable: statement.dyeable ? Boolean(evaluateExpression(statement.dyeable, context)) : undefined,
      color: statement.color ? evaluateExpression(statement.color, context) : undefined,
      usePlayerTexture: statement.usePlayerTexture ? Boolean(evaluateExpression(statement.usePlayerTexture, context)) : undefined,
      colorRange: statement.color?.range
    },
    options
  );
  if (!entry) {
    return undefined;
  }
  const content = {
    layers: {
      [layer]: [entry]
    }
  };
  return {
    content,
    mappings: equipmentLayerMappings(statement, layer, entry, context)
  };
}

export function lowerEquipmentBodySugar(
  content: Record<string, JsonValue>,
  context: EvaluationContext,
  range: TextRange,
  options: EquipmentSugarOptions = {}
): EquipmentBodySugarResult {
  const layers = compactLayerNames(content.layers);
  if (!layers) {
    if (content.layers !== undefined && !isJsonObject(content.layers)) {
      options.onError?.("rsgl.invalidEquipmentLayersSugar", "Equipment layers sugar must be a layer name string or list of layer name strings.", range);
    }
    return { content, compactLayers: false };
  }

  if (typeof content.texture !== "string" || content.texture.length === 0) {
    options.onError?.("rsgl.invalidEquipmentLayersTexture", "Equipment layers sugar requires a non-empty top-level texture id.", range);
    return { content, compactLayers: false };
  }

  const entry = createEquipmentLayerEntry(
    content.texture,
    context,
    {
      dyeable: typeof content.dyeable === "boolean" ? content.dyeable : undefined,
      color: content.color,
      usePlayerTexture: typeof content.use_player_texture === "boolean"
        ? content.use_player_texture
        : typeof content.usePlayerTexture === "boolean" ? content.usePlayerTexture : undefined,
      colorRange: range
    },
    options
  );
  if (!entry) {
    return { content, compactLayers: false };
  }

  const layerMap: Record<string, JsonValue> = {};
  for (const layer of layers) {
    layerMap[layer] = [{ ...entry }];
  }

  const result = { ...content };
  delete result.texture;
  delete result.dyeable;
  delete result.color;
  delete result.use_player_texture;
  delete result.usePlayerTexture;
  result.layers = layerMap;
  return { content: result, compactLayers: true };
}

function createEquipmentLayerEntry(
  texture: string,
  context: EvaluationContext,
  optionsValue: {
    dyeable?: boolean;
    color?: JsonValue;
    usePlayerTexture?: boolean;
    colorRange?: TextRange;
  },
  options: EquipmentSugarOptions
): Record<string, JsonValue> | undefined {
  const entry: Record<string, JsonValue> = {
    texture: normalizeResourceId(texture, context.namespace)
  };

  const hasColor = optionsValue.color !== undefined;
  const dyeable = optionsValue.dyeable ?? hasColor;
  if (dyeable) {
    if (hasColor && (typeof optionsValue.color !== "number" || !Number.isFinite(optionsValue.color))) {
      options.onError?.("rsgl.invalidEquipmentLayerColor", "Equipment layer dyeable color must evaluate to a finite number.", optionsValue.colorRange ?? { start: 0, end: 0 });
      return undefined;
    }
    entry.dyeable = typeof optionsValue.color === "number"
      ? { ["color_when_undyed"]: optionsValue.color }
      : {};
  }

  if (optionsValue.usePlayerTexture !== undefined) {
    entry.use_player_texture = optionsValue.usePlayerTexture;
  }

  return entry;
}

function compactLayerNames(value: JsonValue | undefined): string[] | null {
  if (typeof value === "string") {
    return value.length > 0 ? [value] : null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      return null;
    }
    result.push(item);
  }
  return result;
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeResourceId(value: string, namespace: string): string {
  return value.includes(":") ? value : `${namespace}:${value}`;
}

function equipmentLayerMappings(
  statement: EquipmentLayerStmtNode,
  layer: string,
  entry: Record<string, JsonValue>,
  context: EvaluationContext
): ResourceBodyFragment["mappings"] {
  const layerPath = appendGeneratedPath("/layers", layer);
  const entryPath = appendGeneratedPath(layerPath, "0");
  const mappings: ResourceBodyFragment["mappings"] = [
    {
      generatedPath: layerPath,
      sourceRange: statement.range,
      context
    },
    {
      generatedPath: entryPath,
      sourceRange: statement.range,
      context
    }
  ];
  if (statement.texture) {
    mappings.push({
      generatedPath: appendGeneratedPath(entryPath, "texture"),
      sourceRange: statement.texture.range,
      context
    });
  }
  if (entry.dyeable !== undefined) {
    mappings.push({
      generatedPath: appendGeneratedPath(entryPath, "dyeable"),
      sourceRange: (statement.color ?? statement.dyeable ?? statement).range,
      context
    });
  }
  if (entry.use_player_texture !== undefined) {
    mappings.push({
      generatedPath: appendGeneratedPath(entryPath, "use_player_texture"),
      sourceRange: (statement.usePlayerTexture ?? statement).range,
      context
    });
  }
  return mappings;
}
