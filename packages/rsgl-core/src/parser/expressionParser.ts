import { binaryPrecedence } from "./statementKeywords";
import { parseTemplateStringParts } from "./templateString";
import {
  getNodeOrTokenFullRange,
  getNodeOrTokenRange,
  TypeParser
} from "./typeParser";
import {
  ArgumentNode,
  BlockNode,
  ExprNode,
  IdentifierNode,
  LambdaExprNode,
  ListExprNode,
  ListSpreadNode,
  MatchArmNode,
  ObjectEntryNode,
  ObjectExprNode,
  ObjectPropertyNode,
  ResourceBodyNode,
  RsglNode,
  RsglToken
} from "./types";

interface ExpressionOptions {
  stopTexts?: readonly string[];
  /** Allows the first expression token to begin on the line after its introducer. */
  allowLeadingLineBreak?: boolean;
}

export class ExpressionParser extends TypeParser {
  protected parseExpression(options: ExpressionOptions = {}, minPrecedence = 0): ExprNode {
    const stopTexts = options.stopTexts ?? [];
    if (this.isExpressionStop(stopTexts, options.allowLeadingLineBreak === true)) {
      this.addDiagnosticAtCurrent("rsgl.expectedExpression", "Expected expression.");
      return this.missingExprAt(this.current());
    }

    let left = this.parsePrefixExpression(stopTexts);
    left = this.parsePostfixExpression(left, stopTexts);

    while (!this.isExpressionStop(stopTexts)) {
      if (this.current().text === "=>" && left.kind === "IdentifierExpr") {
        if (minPrecedence > 0) {
          break;
        }
        left = this.finishSingleParameterLambda(left, stopTexts);
        continue;
      }

      if (this.current().text === "in" && left.kind === "IdentifierExpr") {
        const start = left;
        this.advance();
        const iterable = this.parseExpression(options, 1);
        left = {
          kind: "ForInExpr",
          binding: start.name,
          iterable,
          range: { start: start.range.start, end: iterable.range.end },
          fullRange: { start: start.fullRange.start, end: iterable.fullRange.end }
        };
        continue;
      }

      if (this.current().text === "?") {
        if (minPrecedence > 1) {
          break;
        }
        const start = left;
        this.advance();
        const whenTrue = this.parseExpression({ stopTexts: [":"] });
        this.expectText(":", "Expected ':' in conditional expression.");
        const whenFalse = this.parseExpression(options, 1);
        left = {
          kind: "ConditionalExpr",
          condition: start,
          whenTrue,
          whenFalse,
          range: { start: start.range.start, end: whenFalse.range.end },
          fullRange: { start: start.fullRange.start, end: whenFalse.fullRange.end }
        };
        continue;
      }

      const compoundNotIn = this.current().text === "not" && this.peekText(1) === "in";
      const operatorText = compoundNotIn ? "not in" : this.current().text;
      const precedence = binaryPrecedence.get(operatorText);
      if (precedence === undefined || precedence < minPrecedence) {
        break;
      }

      const operator = operatorText;
      this.advance();
      if (compoundNotIn) {
        this.advance();
      }
      const right = this.parseExpression(options, precedence + 1);
      if (operator === "..") {
        left = {
          kind: "RangeExpr",
          startExpr: left,
          endExpr: right,
          inclusive: true,
          range: { start: left.range.start, end: right.range.end },
          fullRange: { start: left.fullRange.start, end: right.fullRange.end }
        };
      } else {
        left = {
          kind: "BinaryExpr",
          operator,
          left,
          right,
          range: { start: left.range.start, end: right.range.end },
          fullRange: { start: left.fullRange.start, end: right.fullRange.end }
        };
      }
    }

    return left;
  }

  private parsePrefixExpression(stopTexts: readonly string[]): ExprNode {
    const token = this.current();
    if (token.text === "!" || token.text === "-") {
      const operator = this.advance().text;
      const operand = this.parseExpression({ stopTexts }, 8);
      return {
        kind: "UnaryExpr",
        operator,
        operand,
        range: { start: token.offset, end: operand.range.end },
        fullRange: { start: this.fullStart(token), end: operand.fullRange.end }
      };
    }

    if (token.text === "(") {
      if (this.looksLikeParenthesizedLambda()) {
        return this.parseParenthesizedLambda(stopTexts);
      }
      this.advance();
      const expression = this.parseExpression({ stopTexts: [")"] });
      this.expectText(")", "Expected ')' after expression.");
      return expression;
    }

    if (token.text === "{") {
      return this.parseObjectExpression();
    }
    if (token.text === "[") {
      return this.parseListExpression();
    }
    if (token.text === "match") {
      return this.parseMatchExpression();
    }
    if (token.kind === "string") {
      return this.parseStringLiteral();
    }
    if (token.kind === "templateString") {
      return this.parseTemplateStringExpression();
    }
    if (token.kind === "number") {
      return this.parseNumberLiteral();
    }
    if (token.kind === "resourceLocation") {
      const consumed = this.advance();
      return {
        kind: "ResourceLocationExpr",
        value: consumed.text,
        ...this.nodeRanges(consumed, consumed)
      };
    }
    if (token.text === "true" || token.text === "false") {
      const consumed = this.advance();
      return {
        kind: "BooleanLiteral",
        value: consumed.text === "true",
        ...this.nodeRanges(consumed, consumed)
      };
    }
    if (token.text === "null") {
      const consumed = this.advance();
      return {
        kind: "NullLiteral",
        ...this.nodeRanges(consumed, consumed)
      };
    }
    if (token.kind === "identifier" || token.kind === "keyword") {
      return this.parseIdentifierOrPathExpression();
    }

    this.addDiagnosticAtCurrent("rsgl.expectedExpression", "Expected expression.");
    if (!this.isAtEnd()) {
      this.advance();
    }
    return this.missingExprAt(token);
  }

  private parsePostfixExpression(expression: ExprNode, stopTexts: readonly string[]): ExprNode {
    let result = expression;
    let reading = true;
    while (reading && !this.isExpressionStop(stopTexts)) {
      if (this.isStatementBoundary(this.current())) {
        break;
      }
      if (this.current().text === "(") {
        result = this.finishCallExpression(result);
      } else if (this.current().text === "." && this.peekKind(1) !== "number") {
        const dot = this.advance();
        const property = this.parseIdentifier("Expected member name.") ?? this.syntheticIdentifier(dot, "");
        result = {
          kind: "MemberExpr",
          object: result,
          property,
          range: { start: result.range.start, end: property.range.end },
          fullRange: { start: result.fullRange.start, end: property.fullRange.end }
        };
      } else if (this.current().text === "[") {
        const start = result;
        this.advance();
        const index = this.parseExpression({ stopTexts: ["]"] });
        this.expectText("]", "Expected ']' after index expression.");
        result = {
          kind: "IndexExpr",
          object: start,
          index,
          range: { start: start.range.start, end: this.previousOr(this.current()).offset + this.previousOr(this.current()).length },
          fullRange: { start: start.fullRange.start, end: this.previousOr(this.current()).offset + this.previousOr(this.current()).length }
        };
      } else {
        reading = false;
      }
    }
    return result;
  }

  private finishSingleParameterLambda(parameter: Extract<ExprNode, { kind: "IdentifierExpr" }>, stopTexts: readonly string[]): LambdaExprNode {
    this.expectText("=>", "Expected '=>' in lambda expression.");
    const body = this.parseExpression({ stopTexts });
    return {
      kind: "LambdaExpr",
      parameters: [parameter.name],
      body,
      range: { start: parameter.range.start, end: body.range.end },
      fullRange: { start: parameter.fullRange.start, end: body.fullRange.end }
    };
  }

  private parseParenthesizedLambda(stopTexts: readonly string[]): LambdaExprNode {
    const start = this.current();
    const parameters: IdentifierNode[] = [];
    this.expectText("(", "Expected lambda parameter list.");
    while (!this.isAtEnd() && this.current().text !== ")") {
      const mark = this.mark();
      if (this.current().text === "...") {
        const rest = this.advance();
        this.addDiagnostic(
          "rsgl.userRestParameterNotSupported",
          "User-defined lambda rest parameters are not supported; remove '...'.",
          getNodeOrTokenRange(rest)
        );
      }
      const parameter = this.parseIdentifier("Expected lambda parameter.");
      if (parameter) {
        parameters.push(parameter);
      }
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse lambda parameter; skipping token.");
    }
    this.expectText(")", "Expected ')' after lambda parameters.");
    this.expectText("=>", "Expected '=>' in lambda expression.");
    const body = this.parseExpression({ stopTexts });
    return {
      kind: "LambdaExpr",
      parameters,
      body,
      range: { start: start.offset, end: body.range.end },
      fullRange: { start: this.fullStart(start), end: body.fullRange.end }
    };
  }

  protected finishCallExpression(callee: ExprNode): ExprNode {
    const start = callee;
    const args: ArgumentNode[] = [];
    this.matchText("(");
    while (!this.isAtEnd() && this.current().text !== ")") {
      const mark = this.mark();
      const argStart = this.current();
      let name: IdentifierNode | undefined;
      if ((this.current().kind === "identifier" || this.current().kind === "keyword") && this.peekText(1) === ":") {
        name = this.parseIdentifier("Expected argument name.") ?? undefined;
        this.matchText(":");
      }
      const value = this.parseExpression({ stopTexts: [",", ")"] });
      args.push({
        kind: "Argument",
        name,
        value,
        ...this.nodeRanges(argStart, this.previousOr(argStart))
      });
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse argument; skipping token.");
    }
    this.expectText(")", "Expected ')' after arguments.");
    const end = this.previousOr(this.current());
    return {
      kind: "CallExpr",
      callee,
      args,
      range: { start: start.range.start, end: end.offset + end.length },
      fullRange: { start: start.fullRange.start, end: end.offset + end.length }
    };
  }

  private parseIdentifierOrPathExpression(): ExprNode {
    const first = this.parseIdentifier("Expected identifier.");
    if (!first) {
      return this.missingExprAt(this.current());
    }

    const pathParts = [first.text];
    let endToken = this.previousOr(this.current());
    while (
      this.current().text === "/" &&
      !this.hasLeadingTrivia(this.current()) &&
      (this.peekKind(1) === "identifier" || this.peekKind(1) === "keyword") &&
      !this.hasLeadingTrivia(this.peek(1))
    ) {
      pathParts.push(this.advance().text);
      const segment = this.advance();
      pathParts.push(segment.text);
      endToken = segment;
    }

    if (pathParts.length > 1) {
      return {
        kind: "ResourceLocationExpr",
        value: pathParts.join(""),
        range: { start: first.range.start, end: endToken.offset + endToken.length },
        fullRange: { start: first.fullRange.start, end: endToken.offset + endToken.length }
      };
    }

    return {
      kind: "IdentifierExpr",
      name: first,
      range: first.range,
      fullRange: first.fullRange
    };
  }

  protected parseObjectExpression(): ObjectExprNode {
    const start = this.current();
    const properties: ObjectEntryNode[] = [];
    this.expectText("{", "Expected object body.");
    while (!this.isAtEnd() && this.current().text !== "}") {
      const mark = this.mark();
      const property = this.parseObjectEntry();
      if (property) {
        properties.push(property);
      }
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse object property; skipping token.");
    }
    this.expectText("}", "Expected '}' after object.");
    return {
      kind: "ObjectExpr",
      properties,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseObjectEntry(): ObjectEntryNode | null {
    if (this.current().text !== "...") {
      return this.parseObjectProperty();
    }
    const start = this.advance();
    const expression = this.parseExpression({ stopTexts: [",", "}"] });
    return {
      kind: "ObjectSpread",
      expression,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseObjectProperty(): ObjectPropertyNode | null {
    const start = this.current();
    const key = this.parsePropertyKey();
    if (!key) {
      this.recoverToLineEnd();
      return null;
    }
    const hasSeparator = this.matchText(":") || this.matchText("=");
    if (!hasSeparator && key.kind === "Identifier" && (
      this.current().text === ","
      || this.current().text === "}"
      || this.isStatementBoundary(this.current())
    )) {
      return {
        kind: "ObjectProperty",
        key,
        value: {
          kind: "IdentifierExpr",
          name: key,
          range: key.range,
          fullRange: key.fullRange
        },
        shorthand: true,
        ...this.nodeRanges(start, this.previousOr(start))
      };
    }
    if (!hasSeparator) {
      this.addDiagnosticAtCurrent(
        "rsgl.expectedPropertySeparator",
        "Expected ':', '=', or the end of an object shorthand property after the object key."
      );
    }
    const value = this.parseExpression({ stopTexts: [",", "}"] });
    return {
      kind: "ObjectProperty",
      key,
      value,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parsePropertyKey(): ObjectPropertyNode["key"] | null {
    if (this.current().text === "[") {
      const start = this.advance();
      const expression = this.parseExpression({ stopTexts: ["]"] });
      this.expectText("]", "Expected ']' after dynamic key.");
      return {
        kind: "DynamicKey",
        expression,
        ...this.nodeRanges(start, this.previousOr(start))
      };
    }
    if (this.current().kind === "string") {
      return this.parseStringLiteral();
    }
    if (this.current().kind === "number") {
      return this.parseNumberLiteral();
    }
    return this.parseIdentifier("Expected object key.");
  }

  private parseListExpression(): ListExprNode {
    const start = this.current();
    const elements: ListExprNode["elements"] = [];
    this.expectText("[", "Expected list body.");
    while (!this.isAtEnd() && this.current().text !== "]") {
      const mark = this.mark();
      elements.push(this.current().text === "..."
        ? this.parseListSpread()
        : this.parseExpression({ stopTexts: [",", "]"] }));
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse list element; skipping token.");
    }
    this.expectText("]", "Expected ']' after list.");
    return {
      kind: "ListExpr",
      elements,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseListSpread(): ListSpreadNode {
    const start = this.advance();
    const expression = this.parseExpression({ stopTexts: [",", "]"] });
    return {
      kind: "ListSpread",
      expression,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseMatchExpression(): ExprNode {
    const start = this.advance();
    const expression = this.parseExpression({ stopTexts: ["{"] });
    const arms: MatchArmNode[] = [];
    this.expectText("{", "Expected match body.");
    while (!this.isAtEnd() && this.current().text !== "}") {
      const mark = this.mark();
      const armStart = this.current();
      const patterns: ExprNode[] = [];
      patterns.push(this.parseExpression({ stopTexts: ["|", "->"] }));
      while (this.matchText("|")) {
        patterns.push(this.parseExpression({ stopTexts: ["|", "->"] }));
      }
      this.expectText("->", "Expected '->' in match arm.");
      const value = this.parseExpression({ stopTexts: [] });
      arms.push({
        kind: "MatchArm",
        patterns,
        value,
        ...this.nodeRanges(armStart, this.previousOr(armStart))
      });
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse match arm; skipping token.");
    }
    this.expectText("}", "Expected '}' after match.");
    return {
      kind: "MatchExpr",
      expression,
      arms,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseTemplateStringExpression(): ExprNode {
    const token = this.advance();
    return {
      kind: "TemplateStringExpr",
      raw: token.text,
      parts: parseTemplateStringParts(token),
      ...this.nodeRanges(token, token)
    };
  }

  protected emptyObjectAt(token: RsglToken, message: string): ObjectExprNode {
    this.addDiagnosticAtCurrent("rsgl.expectedObject", message);
    return {
      kind: "ObjectExpr",
      properties: [],
      ...this.nodeRanges(token, token)
    };
  }

  protected emptyBlockAt(token: RsglToken, message: string): BlockNode {
    this.addDiagnosticAtCurrent("rsgl.expectedBody", message);
    return {
      kind: "Block",
      statements: [],
      ...this.nodeRanges(token, token)
    };
  }

  protected emptyResourceBodyAt(token: RsglToken, message: string): ResourceBodyNode {
    this.addDiagnosticAtCurrent("rsgl.expectedResourceBody", message);
    return {
      kind: "ResourceBody",
      statements: [],
      ...this.nodeRanges(token, token)
    };
  }

  protected missingExprAt(token: RsglToken | RsglNode): ExprNode {
    return {
      kind: "MissingExpr",
      range: getNodeOrTokenRange(token),
      fullRange: getNodeOrTokenFullRange(token)
    };
  }

  private isExpressionStop(
    stopTexts: readonly string[],
    allowCurrentLineBoundary = false
  ): boolean {
    if (this.isAtEnd()) {
      return true;
    }
    if (stopTexts.includes(this.current().text)) {
      return true;
    }
    return stopTexts.length === 0
      && !allowCurrentLineBoundary
      && this.isStatementBoundary(this.current());
  }

  protected recoverToLineEnd(): void {
    while (!this.isAtEnd() && !this.isStatementBoundary(this.current()) && this.current().text !== "}") {
      this.advance();
    }
  }

  private hasLeadingTrivia(token: RsglToken): boolean {
    return token.leadingTrivia.length > 0;
  }

  private looksLikeParenthesizedLambda(): boolean {
    if (this.current().text !== "(") {
      return false;
    }
    let index = this.tokenOffset() + 1;
    let expectParameter = true;
    while (index < this.tokens.length) {
      const token = this.tokens[index];
      if (token.text === ")") {
        return this.tokens[index + 1]?.text === "=>";
      }
      if (expectParameter) {
        if (token.text === "...") {
          index++;
        }
        const parameter = this.tokens[index];
        if (parameter?.kind !== "identifier" && parameter?.kind !== "keyword") {
          return false;
        }
        expectParameter = false;
      } else {
        if (token.text !== ",") {
          return false;
        }
        expectParameter = true;
      }
      index++;
    }
    return false;
  }
}

export class StandaloneExpressionParser extends ExpressionParser {
  public parse(): ExprNode {
    return this.parseExpression();
  }
}
