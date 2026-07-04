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
  if (statement.selector !== "format") {
    return null;
  }
  if (statement.edition && statement.edition.text !== "java") {
    diagnostics.push({
      code: "rsgl.unsupportedTargetEdition",
      message: `Unsupported RSGL target edition '${statement.edition.text}'.`,
      severity: "error",
      range: statement.edition.range
    });
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
