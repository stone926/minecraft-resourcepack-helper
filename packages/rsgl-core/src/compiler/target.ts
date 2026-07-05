import { RsglModule, TargetDeclNode } from "../parser";
import { EvaluationContext, evaluateExpression } from "./evaluate";
import { JsonValue, RsglCompileDiagnostic } from "./ir";

export interface RsglTargetPackFormat {
  major: number;
  minor?: number;
}

export interface RsglTargetSource {
  module: RsglModule;
  namespace: string;
}

export interface RsglTargetResolution {
  targetPackFormat?: RsglTargetPackFormat;
  diagnostics: RsglCompileDiagnostic[];
}

const javaResourcePackFormatsByMinecraftVersion = new Map<string, RsglTargetPackFormat>([
  ["1.21.11", { major: 75, minor: 0 }],
  ["1.21.10", { major: 69, minor: 0 }],
  ["1.21.9", { major: 69, minor: 0 }],
  ["1.21.8", { major: 64, minor: 0 }],
  ["1.21.7", { major: 64, minor: 0 }],
  ["1.21.6", { major: 63, minor: 0 }],
  ["1.21.5", { major: 55, minor: 0 }],
  ["1.21.4", { major: 46, minor: 0 }],
  ["1.21.3", { major: 42, minor: 0 }],
  ["1.21.2", { major: 42, minor: 0 }],
  ["1.21.1", { major: 34, minor: 0 }],
  ["1.21", { major: 34, minor: 0 }],
  ["1.20.6", { major: 32, minor: 0 }],
  ["1.20.5", { major: 32, minor: 0 }],
  ["1.20.4", { major: 22, minor: 0 }],
  ["1.20.3", { major: 18, minor: 0 }],
  ["1.20.2", { major: 18, minor: 0 }],
  ["1.20.1", { major: 15, minor: 0 }],
  ["1.20", { major: 15, minor: 0 }],
  ["1.19.4", { major: 13, minor: 0 }],
  ["1.19.3", { major: 12, minor: 0 }],
  ["1.19.2", { major: 12, minor: 0 }],
  ["1.19.1", { major: 9, minor: 0 }],
  ["1.19", { major: 9, minor: 0 }],
  ["1.18.2", { major: 8, minor: 0 }],
  ["1.18.1", { major: 8, minor: 0 }],
  ["1.18", { major: 8, minor: 0 }],
  ["1.17.1", { major: 7, minor: 0 }],
  ["1.17", { major: 7, minor: 0 }],
  ["1.16.5", { major: 6, minor: 0 }],
  ["1.16.4", { major: 6, minor: 0 }],
  ["1.16.3", { major: 6, minor: 0 }],
  ["1.16.2", { major: 6, minor: 0 }],
  ["1.16.1", { major: 5, minor: 0 }],
  ["1.16", { major: 5, minor: 0 }],
  ["1.15.2", { major: 5, minor: 0 }],
  ["1.15.1", { major: 5, minor: 0 }],
  ["1.15", { major: 5, minor: 0 }]
]);

export function resolveTargetPackFormat(sources: RsglTargetSource[]): RsglTargetResolution {
  const diagnostics: RsglCompileDiagnostic[] = [];
  let resolved: RsglTargetPackFormat | undefined;

  for (const source of sources) {
    for (const statement of source.module.statements) {
      if (statement.kind !== "TargetDecl") {
        continue;
      }
      const target = targetPackFormatFromDecl(statement, source.namespace, diagnostics);
      if (!target) {
        continue;
      }
      if (resolved && compareTargetPackFormats(resolved, target) !== 0) {
        diagnostics.push({
          code: "rsgl.conflictingTargetFormat",
          message: `Conflicting target pack format ${target.major}.${target.minor ?? 0}; expected ${resolved.major}.${resolved.minor ?? 0}.`,
          severity: "error",
          range: statement.range
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
  diagnostics: RsglCompileDiagnostic[]
): RsglTargetPackFormat | null {
  if (statement.edition && statement.edition.text !== "java") {
    diagnostics.push({
      code: "rsgl.unsupportedTargetEdition",
      message: `Unsupported RSGL target edition '${statement.edition.text}'.`,
      severity: "error",
      range: statement.edition.range
    });
    return null;
  }
  if (statement.selector === "mc") {
    return targetPackFormatFromMinecraftVersion(statement, namespace, diagnostics);
  }
  if (statement.selector !== "format") {
    return null;
  }

  const value = evaluateExpression(statement.value, targetEvaluationContext(namespace));
  const target = targetPackFormatValue(value);
  if (!target) {
    diagnostics.push({
      code: "rsgl.invalidTargetFormat",
      message: "Target pack format must be a finite number or [major, minor] array.",
      severity: "error",
      range: statement.value.range
    });
    return null;
  }
  return target;
}

function targetPackFormatFromMinecraftVersion(
  statement: TargetDeclNode,
  namespace: string,
  diagnostics: RsglCompileDiagnostic[]
): RsglTargetPackFormat | null {
  const value = evaluateExpression(statement.value, targetEvaluationContext(namespace));
  if (typeof value !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(value)) {
    diagnostics.push({
      code: "rsgl.invalidTargetMinecraftVersion",
      message: "Target Minecraft version must be a string like \"1.21.11\".",
      severity: "error",
      range: statement.value.range
    });
    return null;
  }

  const target = javaResourcePackFormatsByMinecraftVersion.get(value);
  if (!target) {
    diagnostics.push({
      code: "rsgl.unknownTargetMinecraftVersion",
      message: `No Java resource pack format mapping is defined for Minecraft ${value}; use target java format [major, minor] instead.`,
      severity: "error",
      range: statement.value.range
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
