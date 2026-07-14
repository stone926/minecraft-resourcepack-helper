import { RsglModule, TargetDeclNode } from "../parser";
import { EvaluationContext, evaluateExpression } from "./evaluate";
import { JsonValue, RsglCompileDiagnostic } from "./ir";
import {
  rsglTargetPackFormatForMinecraftVersion,
  type RsglNormalizedProjectTarget,
  type RsglTargetPackFormat
} from "./targetConfig";

export interface RsglTargetSource {
  module: RsglModule;
  namespace: string;
  fileName?: string;
}

export interface RsglTargetResolution {
  targetPackFormat?: RsglTargetPackFormat;
  diagnostics: RsglCompileDiagnostic[];
}

export function resolveTargetPackFormat(
  sources: RsglTargetSource[],
  projectTarget?: RsglNormalizedProjectTarget
): RsglTargetResolution {
  const diagnostics: RsglCompileDiagnostic[] = [];
  let resolved: RsglTargetPackFormat | undefined = projectTarget
    ? { ...projectTarget.packFormat }
    : undefined;

  for (const source of sources) {
    for (const statement of source.module.statements) {
      if (statement.kind !== "TargetDecl") {
        continue;
      }
      const target = targetPackFormatFromDecl(
        statement,
        source.namespace,
        diagnostics,
        source.fileName
      );
      if (!target) {
        continue;
      }
      if (resolved && compareTargetPackFormats(resolved, target) !== 0) {
        diagnostics.push({
          code: "rsgl.conflictingTargetFormat",
          message: `Conflicting target pack format ${target.major}.${target.minor ?? 0}; expected ${resolved.major}.${resolved.minor ?? 0}.`,
          severity: "error",
          range: statement.range,
          ...(source.fileName ? { fileName: source.fileName } : {})
        });
        continue;
      }
      resolved = target;
    }
  }

  return { targetPackFormat: resolved, diagnostics };
}

function targetPackFormatFromDecl(
  statement: TargetDeclNode,
  namespace: string,
  diagnostics: RsglCompileDiagnostic[],
  fileName?: string
): RsglTargetPackFormat | null {
  if (statement.edition && statement.edition.text !== "java") {
    diagnostics.push({
      code: "rsgl.unsupportedTargetEdition",
      message: `Unsupported RSGL target edition '${statement.edition.text}'.`,
      severity: "error",
      range: statement.edition.range,
      ...(fileName ? { fileName } : {})
    });
    return null;
  }
  if (statement.selector === "mc") {
    return targetPackFormatFromMinecraftVersion(statement, namespace, diagnostics, fileName);
  }
  if (statement.selector !== "format") {
    return null;
  }

  const value = normalizeJsonValue(evaluateExpression(statement.value, targetEvaluationContext(namespace)));
  const target = targetPackFormatValue(value);
  if (!target) {
    diagnostics.push({
      code: "rsgl.invalidTargetFormat",
      message: "Target pack format must be a finite number or [major, minor] array.",
      severity: "error",
      range: statement.value.range,
      ...(fileName ? { fileName } : {})
    });
    return null;
  }
  return target;
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (value === undefined || (value && typeof value === "object" && !Array.isArray(value) && (value as { kind?: string }).kind === "lambda")) {
    return null;
  }
  return value as JsonValue;
}

function targetPackFormatFromMinecraftVersion(
  statement: TargetDeclNode,
  namespace: string,
  diagnostics: RsglCompileDiagnostic[],
  fileName?: string
): RsglTargetPackFormat | null {
  const value = evaluateExpression(statement.value, targetEvaluationContext(namespace));
  if (typeof value !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(value)) {
    diagnostics.push({
      code: "rsgl.invalidTargetMinecraftVersion",
      message: "Target Minecraft version must be a string like \"1.21.11\".",
      severity: "error",
      range: statement.value.range,
      ...(fileName ? { fileName } : {})
    });
    return null;
  }

  const target = rsglTargetPackFormatForMinecraftVersion(value);
  if (!target) {
    diagnostics.push({
      code: "rsgl.unknownTargetMinecraftVersion",
      message: `No Java resource pack format mapping is defined for Minecraft ${value}; use target java format [major, minor] instead.`,
      severity: "error",
      range: statement.value.range,
      ...(fileName ? { fileName } : {})
    });
    return null;
  }

  return { ...target };
}

function targetPackFormatValue(value: JsonValue | undefined): RsglTargetPackFormat | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { major: value, minor: 0 };
  }
  if (Array.isArray(value) && typeof value[0] === "number" && Number.isFinite(value[0])) {
    const minor = typeof value[1] === "number" && Number.isFinite(value[1]) ? value[1] : 0;
    return { major: value[0], minor };
  }
  return null;
}

function targetEvaluationContext(namespace: string): EvaluationContext {
  return {
    namespace,
    variables: new Map()
  };
}

function compareTargetPackFormats(left: RsglTargetPackFormat, right: RsglTargetPackFormat): number {
  return left.major === right.major
    ? (left.minor ?? 0) - (right.minor ?? 0)
    : left.major - right.major;
}
