import { ParserContext, tokenRange } from "./parserContext";
import { binaryPrecedence } from "./statementKeywords";
import { parseTemplateStringParts } from "./templateString";
import {
  ArgumentNode,
  BlockNode,
  BooleanLiteralNode,
  ExprNode,
  FunctionTypeNode,
  IdentifierNode,
  LambdaExprNode,
  MatchArmNode,
  NumberLiteralNode,
  ObjectExprNode,
  ObjectPropertyNode,
  ResourceBodyNode,
  RsglNode,
  RsglToken,
  StateKeySugarNode,
  StringLiteralNode,
  TypeNode
} from "./types";

interface ExpressionOptions {
  stopTexts?: readonly string[];
}

export function unquoteString(raw: string): string {
  if (!raw.startsWith("\"")) {
    return raw;
  }
  const body = raw.endsWith("\"") ? raw.slice(1, -1) : raw.slice(1);
  return body.replace(/\\(u[0-9A-Fa-f]{4}|[nrt"\\])/g, (_match, escape: string) => {
    if (escape === "n") {
      return "\n";
    }
    if (escape === "r") {
      return "\r";
    }
    if (escape === "t") {
      return "\t";
    }
    if (escape.startsWith("u")) {
      return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    }
    return escape;
  });
}

export class ExpressionParser extends ParserContext {
  protected parseExpression(options: ExpressionOptions = {}, minPrecedence = 0): ExprNode {
    const stopTexts = options.stopTexts ?? [];
    if (this.isExpressionStop(stopTexts)) {
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

      const precedence = binaryPrecedence.get(this.current().text);
      if (precedence === undefined || precedence < minPrecedence) {
        break;
      }

      const operator = this.advance().text;
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
    const properties: ObjectPropertyNode[] = [];
    this.expectText("{", "Expected object body.");
    while (!this.isAtEnd() && this.current().text !== "}") {
      const mark = this.mark();
      const property = this.parseObjectProperty();
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

  private parseObjectProperty(): ObjectPropertyNode | null {
    const start = this.current();
    const key = this.parsePropertyKey();
    if (!key) {
      this.recoverToLineEnd();
      return null;
    }
    if (!this.matchText(":") && !this.matchText("=")) {
      this.addDiagnosticAtCurrent("rsgl.expectedPropertySeparator", "Expected ':' or '=' after object key.");
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

  private parseListExpression(): ExprNode {
    const start = this.current();
    const elements: ExprNode[] = [];
    this.expectText("[", "Expected list body.");
    while (!this.isAtEnd() && this.current().text !== "]") {
      const mark = this.mark();
      elements.push(this.parseExpression({ stopTexts: [",", "]"] }));
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

  protected parseStateKeySugar(): StateKeySugarNode {
    const start = this.current();
    const entries: ObjectPropertyNode[] = [];
    this.expectText("[", "Expected state key sugar.");
    while (!this.isAtEnd() && this.current().text !== "]") {
      const mark = this.mark();
      const keyStart = this.current();
      const key = this.parsePropertyKey();
      if (!key) {
        break;
      }
      this.expectText("=", "Expected '=' in state key sugar.");
      const value = this.parseExpression({ stopTexts: [",", "]"] });
      entries.push({
        kind: "ObjectProperty",
        key,
        value,
        ...this.nodeRanges(keyStart, this.previousOr(keyStart))
      });
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse state key entry; skipping token.");
    }
    this.expectText("]", "Expected ']' after state key sugar.");
    return {
      kind: "StateKeySugar",
      entries,
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

  protected parseStringLiteral(): StringLiteralNode {
    const token = this.advance();
    return {
      kind: "StringLiteral",
      value: unquoteString(token.text),
      raw: token.text,
      ...this.nodeRanges(token, token)
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

  private parseNumberLiteral(): NumberLiteralNode {
    const token = this.advance();
    return {
      kind: "NumberLiteral",
      value: token.text.startsWith("0x") || token.text.startsWith("0X") ? Number.parseInt(token.text.slice(2), 16) : Number(token.text),
      raw: token.text,
      ...this.nodeRanges(token, token)
    };
  }

  protected parseType(): TypeNode {
    const first = this.parsePrimaryType();
    const options = [first];
    while (this.matchText("|")) {
      options.push(this.parsePrimaryType());
    }
    if (options.length === 1) {
      return first;
    }
    return {
      kind: "UnionType",
      options,
      range: { start: options[0].range.start, end: options[options.length - 1].range.end },
      fullRange: { start: options[0].fullRange.start, end: options[options.length - 1].fullRange.end }
    };
  }

  private parsePrimaryType(): TypeNode {
    const start = this.current();
    if (this.current().text === "(") {
      return this.parseFunctionType();
    }
    if (this.current().kind === "string") {
      return { kind: "LiteralType", value: this.parseStringLiteral(), ...this.nodeRanges(start, this.previousOr(start)) };
    }
    if (this.current().kind === "number") {
      return { kind: "LiteralType", value: this.parseNumberLiteral(), ...this.nodeRanges(start, this.previousOr(start)) };
    }
    if (this.current().text === "true" || this.current().text === "false") {
      return { kind: "LiteralType", value: this.booleanLiteral(this.advance(), start.text === "true"), ...this.nodeRanges(start, this.previousOr(start)) };
    }
    if (this.current().text === "null") {
      return { kind: "LiteralType", value: { kind: "NullLiteral", ...this.nodeRanges(this.advance(), this.previousOr(start)) }, ...this.nodeRanges(start, this.previousOr(start)) };
    }

    const name = this.parseIdentifier("Expected type name.");
    if (!name) {
      return { kind: "MissingType", ...this.nodeRanges(start, start) };
    }
    if (this.matchText("<")) {
      const args: TypeNode[] = [];
      while (!this.isAtEnd() && this.current().text !== ">") {
        const mark = this.mark();
        args.push(this.parseType());
        this.consumeOptionalSeparator();
        this.ensureProgress(mark, "Unable to parse type argument; skipping token.");
      }
      this.expectText(">", "Expected '>' after generic type arguments.");
      return {
        kind: "GenericType",
        name,
        args,
        ...this.nodeRanges(start, this.previousOr(start))
      };
    }
    return {
      kind: "NamedType",
      name,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseFunctionType(): FunctionTypeNode {
    const start = this.current();
    const parameters: TypeNode[] = [];
    this.expectText("(", "Expected function parameter type list.");
    while (!this.isAtEnd() && this.current().text !== ")") {
      const mark = this.mark();
      parameters.push(this.parseType());
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse function parameter type; skipping token.");
    }
    this.expectText(")", "Expected ')' after function parameter types.");
    this.expectText("->", "Expected '->' in function type.");
    const returnType = this.parseType();
    return {
      kind: "FunctionType",
      parameters,
      returnType,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  protected parseIdentifier(message: string): IdentifierNode | null {
    const token = this.current();
    if (token.kind !== "identifier" && token.kind !== "keyword") {
      this.addDiagnosticAtCurrent("rsgl.expectedIdentifier", message);
      return null;
    }
    this.advance();
    return this.syntheticIdentifier(token, token.text);
  }

  protected syntheticIdentifier(token: RsglToken | RsglNode, text: string): IdentifierNode {
    const range = getNodeOrTokenRange(token);
    const fullRange = getNodeOrTokenFullRange(token);
    return {
      kind: "Identifier",
      text,
      range,
      fullRange
    };
  }

  protected booleanLiteral(token: RsglToken, value: boolean): BooleanLiteralNode {
    return {
      kind: "BooleanLiteral",
      value,
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

  private isExpressionStop(stopTexts: readonly string[]): boolean {
    if (this.isAtEnd()) {
      return true;
    }
    if (stopTexts.includes(this.current().text)) {
      return true;
    }
    return stopTexts.length === 0 && this.isStatementBoundary(this.current());
  }

  protected looksLikeStateKeySugar(): boolean {
    if (this.current().text !== "[") {
      return false;
    }
    return (this.peekKind(1) === "identifier" || this.peekKind(1) === "keyword" || this.peekKind(1) === "string") &&
      this.peekText(2) === "=";
  }

  protected consumeOptionalSeparator(): void {
    if (this.current().text === "," || this.current().text === ";") {
      this.advance();
    }
  }

  protected expectText(text: string, message: string): boolean {
    if (this.matchText(text)) {
      return true;
    }
    this.addDiagnosticAtCurrent(expectedTokenDiagnosticCode(text), message);
    return false;
  }

  protected recoverToLineEnd(): void {
    while (!this.isAtEnd() && !this.isStatementBoundary(this.current()) && this.current().text !== "}") {
      this.advance();
    }
  }

  protected nodeRanges(start: RsglToken, end: RsglToken): Pick<RsglNode, "range" | "fullRange"> {
    return {
      range: { start: start.offset, end: end.offset + end.length },
      fullRange: { start: this.fullStart(start), end: end.offset + end.length }
    };
  }

  private fullStart(token: RsglToken): number {
    return token.leadingTrivia.length > 0 ? token.leadingTrivia[0].offset : token.offset;
  }

  private hasLeadingTrivia(token: RsglToken): boolean {
    return token.leadingTrivia.length > 0;
  }

  private peek(ahead: number): RsglToken {
    return this.tokens[this.tokenOffset() + ahead] ?? this.current();
  }

  protected peekText(ahead: number): string {
    return this.peek(ahead).text;
  }

  private peekKind(ahead: number): RsglToken["kind"] {
    return this.peek(ahead).kind;
  }

  private tokenOffset(): number {
    const current = this.current();
    return this.tokens.indexOf(current);
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
        if (token.kind !== "identifier" && token.kind !== "keyword") {
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

function getNodeOrTokenRange(value: RsglToken | RsglNode) {
  if ("range" in value) {
    return value.range;
  }
  return tokenRange(value);
}

function getNodeOrTokenFullRange(value: RsglToken | RsglNode) {
  if ("fullRange" in value) {
    return value.fullRange;
  }
  return tokenRange(value);
}

function expectedTokenDiagnosticCode(text: string): string {
  if (text === "}") {
    return "rsgl.expectedClosingBrace";
  }
  if (text === "]") {
    return "rsgl.expectedClosingBracket";
  }
  if (text === ")") {
    return "rsgl.expectedClosingParen";
  }
  return "rsgl.expectedToken";
}
