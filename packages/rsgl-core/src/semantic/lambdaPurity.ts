import { ExprNode, TextRange } from "../parser";

/**
 * Builtins with side effects (filesystem IO) that lambda bodies must not call.
 * Shared by the semantic checker (editor diagnostics) and the evaluator
 * (compile-time gate), so the rule cannot drift between the two layers.
 */
export const lambdaImpureBuiltinNames: ReadonlySet<string> = new Set(["glob"]);

export interface LambdaImpureCall {
  name: string;
  range: TextRange;
}

export function lambdaImpureCallMessage(name: string): string {
  return `Lambda body cannot call impure builtin '${name}'.`;
}

/**
 * Collects impure builtin calls in a lambda body without descending into
 * nested lambda bodies: each lambda owns its body's report (the checker visits
 * every LambdaExpr), and the evaluator gates nested lambdas when they are
 * called.
 */
export function findLambdaImpureCalls(expression: ExprNode): LambdaImpureCall[] {
  const calls: LambdaImpureCall[] = [];
  collectLambdaImpureCalls(expression, calls);
  return calls;
}

function collectLambdaImpureCalls(expression: ExprNode, calls: LambdaImpureCall[]): void {
  if (expression.kind === "CallExpr") {
    if (expression.callee.kind === "IdentifierExpr" && lambdaImpureBuiltinNames.has(expression.callee.name.text)) {
      calls.push({ name: expression.callee.name.text, range: expression.callee.range });
    }
    collectLambdaImpureCalls(expression.callee, calls);
    expression.args.forEach(arg => collectLambdaImpureCalls(arg.value, calls));
  } else if (expression.kind === "ListExpr") {
    expression.elements.forEach(element => collectLambdaImpureCalls(element, calls));
  } else if (expression.kind === "ObjectExpr") {
    expression.properties.forEach(property => {
      if (property.key.kind === "DynamicKey") {
        collectLambdaImpureCalls(property.key.expression, calls);
      }
      collectLambdaImpureCalls(property.value, calls);
    });
  } else if (expression.kind === "TemplateStringExpr") {
    expression.parts.forEach(part => {
      if (part.kind === "expression") {
        collectLambdaImpureCalls(part.expression, calls);
      }
    });
  } else if (expression.kind === "MemberExpr") {
    collectLambdaImpureCalls(expression.object, calls);
  } else if (expression.kind === "IndexExpr") {
    collectLambdaImpureCalls(expression.object, calls);
    collectLambdaImpureCalls(expression.index, calls);
  } else if (expression.kind === "UnaryExpr") {
    collectLambdaImpureCalls(expression.operand, calls);
  } else if (expression.kind === "BinaryExpr") {
    collectLambdaImpureCalls(expression.left, calls);
    collectLambdaImpureCalls(expression.right, calls);
  } else if (expression.kind === "ConditionalExpr") {
    collectLambdaImpureCalls(expression.condition, calls);
    collectLambdaImpureCalls(expression.whenTrue, calls);
    collectLambdaImpureCalls(expression.whenFalse, calls);
  } else if (expression.kind === "MatchExpr") {
    collectLambdaImpureCalls(expression.expression, calls);
    expression.arms.forEach(arm => {
      arm.patterns.forEach(pattern => collectLambdaImpureCalls(pattern, calls));
      collectLambdaImpureCalls(arm.value, calls);
    });
  } else if (expression.kind === "RangeExpr") {
    collectLambdaImpureCalls(expression.startExpr, calls);
    collectLambdaImpureCalls(expression.endExpr, calls);
  } else if (expression.kind === "StateKeySugar") {
    expression.entries.forEach(entry => {
      if (entry.key.kind === "DynamicKey") {
        collectLambdaImpureCalls(entry.key.expression, calls);
      }
      collectLambdaImpureCalls(entry.value, calls);
    });
  } else if (expression.kind === "ModelApplySugar") {
    collectLambdaImpureCalls(expression.model, calls);
    expression.properties.forEach(property => collectLambdaImpureCalls(property.value, calls));
  } else if (expression.kind === "RandomApply") {
    expression.entries.forEach(entry => collectLambdaImpureCalls(entry, calls));
  } else if (expression.kind === "ForInExpr") {
    collectLambdaImpureCalls(expression.iterable, calls);
  }
}
