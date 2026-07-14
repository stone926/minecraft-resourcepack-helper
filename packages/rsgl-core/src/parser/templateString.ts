import { StandaloneExpressionParser } from "./expressionParser";
import { lexRsgl } from "./lexer";
import {
  ExprNode,
  ObjectPropertyNode,
  RsglNode,
  RsglToken,
  TemplateStringPart
} from "./types";

export function parseTemplateStringParts(token: RsglToken): TemplateStringPart[] {
  const raw = token.text;
  const content = raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw.slice(1);
  const parts: TemplateStringPart[] = [];
  let index = 0;
  let textStart = 0;
  while (index < content.length) {
    if (content[index] === "$" && content[index + 1] === "{") {
      if (textStart < index) {
        parts.push({
          kind: "text",
          text: content.slice(textStart, index),
          range: { start: token.offset + 1 + textStart, end: token.offset + 1 + index }
        });
      }
      const exprStart = index + 2;
      const exprEnd = findTemplateExpressionEnd(content, exprStart);
      const expressionText = content.slice(exprStart, exprEnd);
      parts.push({
        kind: "expression",
        expression: parseStandaloneExpression(expressionText, token.offset + 1 + exprStart),
        range: { start: token.offset + 1 + index, end: token.offset + 1 + Math.min(content.length, exprEnd + 1) }
      });
      index = Math.min(content.length, exprEnd + 1);
      textStart = index;
    } else if (content[index] === "\\") {
      index += 2;
    } else {
      index++;
    }
  }
  if (textStart < content.length) {
    parts.push({
      kind: "text",
      text: content.slice(textStart),
      range: { start: token.offset + 1 + textStart, end: token.offset + 1 + content.length }
    });
  }
  return parts;
}

function parseStandaloneExpression(text: string, baseOffset: number): ExprNode {
  const lexResult = lexRsgl(text);
  const parser = new StandaloneExpressionParser(lexResult.tokens, lexResult.diagnostics);
  return offsetExpressionRanges(parser.parse(), baseOffset);
}

function offsetExpressionRanges<T extends ExprNode>(expression: T, offset: number): T {
  offsetNodeRange(expression, offset);
  if (expression.kind === "IdentifierExpr") {
    offsetNodeRange(expression.name, offset);
  } else if (expression.kind === "TemplateStringExpr") {
    for (const part of expression.parts) {
      part.range = offsetRange(part.range, offset);
      if (part.kind === "expression") {
        offsetExpressionRanges(part.expression, offset);
      }
    }
  } else if (expression.kind === "ListExpr") {
    expression.elements.forEach(element => {
      if (element.kind === "ListSpread") {
        offsetNodeRange(element, offset);
        offsetExpressionRanges(element.expression, offset);
      } else {
        offsetExpressionRanges(element, offset);
      }
    });
  } else if (expression.kind === "ObjectExpr") {
    expression.properties.forEach(property => {
      if (property.kind === "ObjectSpread") {
        offsetNodeRange(property, offset);
        offsetExpressionRanges(property.expression, offset);
      } else {
        offsetObjectPropertyRange(property, offset);
      }
    });
  } else if (expression.kind === "RangeExpr") {
    offsetExpressionRanges(expression.startExpr, offset);
    offsetExpressionRanges(expression.endExpr, offset);
  } else if (expression.kind === "CallExpr") {
    offsetExpressionRanges(expression.callee, offset);
    for (const arg of expression.args) {
      offsetNodeRange(arg, offset);
      if (arg.name) {
        offsetNodeRange(arg.name, offset);
      }
      offsetExpressionRanges(arg.value, offset);
    }
  } else if (expression.kind === "MemberExpr") {
    offsetExpressionRanges(expression.object, offset);
    offsetNodeRange(expression.property, offset);
  } else if (expression.kind === "IndexExpr") {
    offsetExpressionRanges(expression.object, offset);
    offsetExpressionRanges(expression.index, offset);
  } else if (expression.kind === "UnaryExpr") {
    offsetExpressionRanges(expression.operand, offset);
  } else if (expression.kind === "BinaryExpr") {
    offsetExpressionRanges(expression.left, offset);
    offsetExpressionRanges(expression.right, offset);
  } else if (expression.kind === "ConditionalExpr") {
    offsetExpressionRanges(expression.condition, offset);
    offsetExpressionRanges(expression.whenTrue, offset);
    offsetExpressionRanges(expression.whenFalse, offset);
  } else if (expression.kind === "MatchExpr") {
    offsetExpressionRanges(expression.expression, offset);
    for (const arm of expression.arms) {
      offsetNodeRange(arm, offset);
      arm.patterns.forEach(pattern => offsetExpressionRanges(pattern, offset));
      offsetExpressionRanges(arm.value, offset);
    }
  }
  return expression;
}

function offsetObjectPropertyRange(property: ObjectPropertyNode, offset: number): void {
  offsetNodeRange(property, offset);
  if (property.key.kind === "DynamicKey") {
    offsetNodeRange(property.key, offset);
    offsetExpressionRanges(property.key.expression, offset);
  } else {
    offsetNodeRange(property.key, offset);
  }
  offsetExpressionRanges(property.value, offset);
}

function offsetNodeRange(node: RsglNode, offset: number): void {
  node.range = offsetRange(node.range, offset);
  node.fullRange = offsetRange(node.fullRange, offset);
}

function offsetRange(range: { start: number; end: number }, offset: number) {
  return { start: range.start + offset, end: range.end + offset };
}

function findTemplateExpressionEnd(content: string, start: number): number {
  let depth = 1;
  for (let index = start; index < content.length; index++) {
    if (content[index] === "{") {
      depth++;
    } else if (content[index] === "}") {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return content.length;
}
