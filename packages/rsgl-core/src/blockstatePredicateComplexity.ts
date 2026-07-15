import type { ExprNode } from "./parser";

export const MAX_BLOCKSTATE_PREDICATE_NODES = 4096;
export const MAX_BLOCKSTATE_PREDICATE_DEPTH = 512;

export interface BlockstatePredicateExpressionComplexity {
  readonly nodes: number;
  readonly depth: number;
  readonly withinLimit: boolean;
}

/** Iteratively measures predicate syntax so hostile nesting never reaches recursive checkers/evaluators. */
export function analyzeBlockstatePredicateExpression(
  root: ExprNode
): BlockstatePredicateExpressionComplexity {
  const stack: Array<{ expression: ExprNode; depth: number }> = [{ expression: root, depth: 1 }];
  let nodes = 0;
  let depth = 0;
  while (stack.length > 0 && nodes <= MAX_BLOCKSTATE_PREDICATE_NODES) {
    const current = stack.pop()!;
    nodes += 1;
    depth = Math.max(depth, current.depth);
    if (depth > MAX_BLOCKSTATE_PREDICATE_DEPTH) {
      break;
    }
    const nextDepth = current.depth + 1;
    const expression = current.expression;
    switch (expression.kind) {
      case "TemplateStringExpr":
        expression.parts.forEach(part => {
          if (part.kind === "expression") {
            stack.push({ expression: part.expression, depth: nextDepth });
          }
        });
        break;
      case "ListExpr":
        expression.elements.forEach(element => stack.push({
          expression: element.kind === "ListSpread" ? element.expression : element,
          depth: nextDepth
        }));
        break;
      case "ObjectExpr":
        expression.properties.forEach(property => {
          if (property.kind === "ObjectSpread") {
            stack.push({ expression: property.expression, depth: nextDepth });
          } else {
            stack.push({ expression: property.value, depth: nextDepth });
            if (property.key.kind === "DynamicKey") {
              stack.push({ expression: property.key.expression, depth: nextDepth });
            }
          }
        });
        break;
      case "RangeExpr":
        stack.push({ expression: expression.startExpr, depth: nextDepth });
        stack.push({ expression: expression.endExpr, depth: nextDepth });
        break;
      case "CallExpr":
        stack.push({ expression: expression.callee, depth: nextDepth });
        expression.args.forEach(argument => stack.push({ expression: argument.value, depth: nextDepth }));
        break;
      case "MemberExpr":
        stack.push({ expression: expression.object, depth: nextDepth });
        break;
      case "IndexExpr":
        stack.push({ expression: expression.object, depth: nextDepth });
        stack.push({ expression: expression.index, depth: nextDepth });
        break;
      case "UnaryExpr":
        stack.push({ expression: expression.operand, depth: nextDepth });
        break;
      case "BinaryExpr":
        stack.push({ expression: expression.left, depth: nextDepth });
        stack.push({ expression: expression.right, depth: nextDepth });
        break;
      case "ConditionalExpr":
        stack.push({ expression: expression.condition, depth: nextDepth });
        stack.push({ expression: expression.whenTrue, depth: nextDepth });
        stack.push({ expression: expression.whenFalse, depth: nextDepth });
        break;
      case "LambdaExpr":
        stack.push({ expression: expression.body, depth: nextDepth });
        break;
      case "MatchExpr":
        stack.push({ expression: expression.expression, depth: nextDepth });
        expression.arms.forEach(arm => {
          arm.patterns.forEach(pattern => stack.push({ expression: pattern, depth: nextDepth }));
          stack.push({ expression: arm.value, depth: nextDepth });
        });
        break;
      case "ForInExpr":
        stack.push({ expression: expression.iterable, depth: nextDepth });
        break;
      default:
        break;
    }
  }
  return {
    nodes,
    depth,
    withinLimit: nodes <= MAX_BLOCKSTATE_PREDICATE_NODES
      && depth <= MAX_BLOCKSTATE_PREDICATE_DEPTH
  };
}
