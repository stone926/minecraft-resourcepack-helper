import { ExprNode, TextRange } from "../parser";
import { builtinEffect } from "./builtins";
import type { RsglBuiltinEffect, RsglSymbol } from "./types";

export type LambdaBuiltinEffectResolver = (
  name: string,
  range: TextRange
) => RsglBuiltinEffect | undefined;

export interface LambdaImpureCall {
  name: string;
  range: TextRange;
}

export function lambdaImpureCallMessage(name: string): string {
  return `Lambda body cannot call impure builtin '${name}'.`;
}

/** Keeps semantic purity tied to the symbol selected by lexical resolution. */
export function resolvedBuiltinEffect(symbol: RsglSymbol | undefined): RsglBuiltinEffect | undefined {
  return symbol?.kind === "builtin" ? symbol.effect : undefined;
}

/**
 * Collects impure builtin calls in a lambda body without descending into
 * nested lambda bodies: each lambda owns its body's report (the checker visits
 * every LambdaExpr), and the evaluator gates nested lambdas when they are
 * called.
 */
export function findLambdaImpureCalls(
  expression: ExprNode,
  resolveEffect: LambdaBuiltinEffectResolver = name => builtinEffect(name)
): LambdaImpureCall[] {
  const calls: LambdaImpureCall[] = [];
  collectLambdaImpureCalls(expression, calls, resolveEffect);
  return calls;
}

function collectLambdaImpureCalls(
  expression: ExprNode,
  calls: LambdaImpureCall[],
  resolveEffect: LambdaBuiltinEffectResolver
): void {
  if (expression.kind === "CallExpr") {
    if (
      expression.callee.kind === "IdentifierExpr"
      && resolveEffect(expression.callee.name.text, expression.callee.range) === "io"
    ) {
      calls.push({ name: expression.callee.name.text, range: expression.callee.range });
    }
    collectLambdaImpureCalls(expression.callee, calls, resolveEffect);
    expression.args.forEach(arg => collectLambdaImpureCalls(arg.value, calls, resolveEffect));
  } else if (expression.kind === "ListExpr") {
    expression.elements.forEach(element => collectLambdaImpureCalls(
      element.kind === "ListSpread" ? element.expression : element,
      calls,
      resolveEffect
    ));
  } else if (expression.kind === "ObjectExpr") {
    expression.properties.forEach(property => {
      if (property.kind === "ObjectSpread") {
        collectLambdaImpureCalls(property.expression, calls, resolveEffect);
        return;
      }
      if (property.key.kind === "DynamicKey") {
        collectLambdaImpureCalls(property.key.expression, calls, resolveEffect);
      }
      collectLambdaImpureCalls(property.value, calls, resolveEffect);
    });
  } else if (expression.kind === "TemplateStringExpr") {
    expression.parts.forEach(part => {
      if (part.kind === "expression") {
        collectLambdaImpureCalls(part.expression, calls, resolveEffect);
      }
    });
  } else if (expression.kind === "MemberExpr") {
    collectLambdaImpureCalls(expression.object, calls, resolveEffect);
  } else if (expression.kind === "IndexExpr") {
    collectLambdaImpureCalls(expression.object, calls, resolveEffect);
    collectLambdaImpureCalls(expression.index, calls, resolveEffect);
  } else if (expression.kind === "UnaryExpr") {
    collectLambdaImpureCalls(expression.operand, calls, resolveEffect);
  } else if (expression.kind === "BinaryExpr") {
    collectLambdaImpureCalls(expression.left, calls, resolveEffect);
    collectLambdaImpureCalls(expression.right, calls, resolveEffect);
  } else if (expression.kind === "ConditionalExpr") {
    collectLambdaImpureCalls(expression.condition, calls, resolveEffect);
    collectLambdaImpureCalls(expression.whenTrue, calls, resolveEffect);
    collectLambdaImpureCalls(expression.whenFalse, calls, resolveEffect);
  } else if (expression.kind === "MatchExpr") {
    collectLambdaImpureCalls(expression.expression, calls, resolveEffect);
    expression.arms.forEach(arm => {
      arm.patterns.forEach(pattern => collectLambdaImpureCalls(pattern, calls, resolveEffect));
      collectLambdaImpureCalls(arm.value, calls, resolveEffect);
    });
  } else if (expression.kind === "RangeExpr") {
    collectLambdaImpureCalls(expression.startExpr, calls, resolveEffect);
    collectLambdaImpureCalls(expression.endExpr, calls, resolveEffect);
  } else if (expression.kind === "StateKeySugar") {
    expression.entries.forEach(entry => {
      if (entry.key.kind === "DynamicKey") {
        collectLambdaImpureCalls(entry.key.expression, calls, resolveEffect);
      }
      collectLambdaImpureCalls(entry.value, calls, resolveEffect);
    });
  } else if (expression.kind === "ModelApplySugar") {
    collectLambdaImpureCalls(expression.model, calls, resolveEffect);
    expression.properties.forEach(property => collectLambdaImpureCalls(property.value, calls, resolveEffect));
  } else if (expression.kind === "RandomApply") {
    expression.entries.forEach(entry => collectLambdaImpureCalls(entry, calls, resolveEffect));
  } else if (expression.kind === "ForInExpr") {
    collectLambdaImpureCalls(expression.iterable, calls, resolveEffect);
  }
}
