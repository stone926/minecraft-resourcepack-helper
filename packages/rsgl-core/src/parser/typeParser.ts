import { ParserContext, tokenRange } from "./parserContext";
import { isTopLevelKeyword } from "./keywords";
import {
  BooleanLiteralNode,
  FunctionTypeNode,
  IdentifierNode,
  NumberLiteralNode,
  ObjectTypeNode,
  ObjectTypePropertyNode,
  RsglNode,
  RsglToken,
  StringLiteralNode,
  TextRange,
  TypeNode
} from "./types";

/** Decodes the escape forms shared by string expressions and literal types. */
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

/**
 * Parses the type-only grammar. Keeping this below the expression parser
 * prevents record type braces from being guessed through ObjectExpr parsing.
 */
export class TypeParser extends ParserContext {
  protected parseType(): TypeNode {
    const first = this.parsePrimaryType();
    const options = [first];
    while (this.matchText("|")) {
      if (this.isUnexpectedDeclarationBoundary()) {
        options.push(this.missingTypeAt(this.current()));
        break;
      }
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
    if (start.text === "(") {
      return this.parseFunctionType();
    }
    if (start.text === "{") {
      return this.parseObjectType();
    }
    if (start.kind === "string") {
      return {
        kind: "LiteralType",
        value: this.parseStringLiteral(),
        ...this.nodeRanges(start, this.previousOr(start))
      };
    }
    if (start.kind === "number") {
      return {
        kind: "LiteralType",
        value: this.parseNumberLiteral(),
        ...this.nodeRanges(start, this.previousOr(start))
      };
    }
    if (start.text === "true" || start.text === "false") {
      return {
        kind: "LiteralType",
        value: this.booleanLiteral(this.advance(), start.text === "true"),
        ...this.nodeRanges(start, this.previousOr(start))
      };
    }
    if (start.text === "null") {
      const token = this.advance();
      return {
        kind: "LiteralType",
        value: { kind: "NullLiteral", ...this.nodeRanges(token, token) },
        ...this.nodeRanges(start, token)
      };
    }

    const name = this.parseIdentifier("Expected type name.");
    if (!name) {
      return this.missingTypeAt(start);
    }

    let parsed: TypeNode;
    if (this.matchText("<")) {
      const args: TypeNode[] = [];
      while (!this.isAtEnd() && this.current().text !== ">") {
        if (this.isUnexpectedDeclarationBoundary()) {
          break;
        }
        const mark = this.mark();
        args.push(this.parseType());
        this.consumeOptionalSeparator();
        this.ensureProgress(mark, "Unable to parse type argument; skipping token.");
      }
      this.expectText(">", "Expected '>' after generic type arguments.");
      parsed = {
        kind: "GenericType",
        name,
        args,
        ...this.nodeRanges(start, this.previousOr(start))
      };
    } else {
      parsed = {
        kind: "NamedType",
        name,
        ...this.nodeRanges(start, this.previousOr(start))
      };
    }

    if (name.text !== "Missing") {
      return parsed;
    }
    this.addDiagnostic(
      "rsgl.internalMissingType",
      "Missing is an internal type sentinel and cannot be written in RSGL source.",
      name.range
    );
    return {
      kind: "MissingType",
      range: parsed.range,
      fullRange: parsed.fullRange
    };
  }

  private parseFunctionType(): FunctionTypeNode {
    const start = this.current();
    const parameters: TypeNode[] = [];
    this.expectText("(", "Expected function parameter type list.");
    while (!this.isAtEnd() && this.current().text !== ")") {
      if (this.isUnexpectedDeclarationBoundary()) {
        break;
      }
      const mark = this.mark();
      parameters.push(this.parseType());
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse function parameter type; skipping token.");
    }
    this.expectText(")", "Expected ')' after function parameter types.");
    this.expectText("->", "Expected '->' in function type.");
    const returnType = this.isUnexpectedDeclarationBoundary()
      ? this.missingTypeAt(this.current())
      : this.parseType();
    return {
      kind: "FunctionType",
      parameters,
      returnType,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseObjectType(): ObjectTypeNode {
    const start = this.current();
    const properties: ObjectTypePropertyNode[] = [];
    this.expectText("{", "Expected object type body.");
    while (!this.isAtEnd() && this.current().text !== "}") {
      if (this.isUnexpectedDeclarationBoundary() && !this.looksLikeObjectTypeProperty()) {
        break;
      }
      if (this.current().text === "," || this.current().text === ";") {
        this.advance();
        continue;
      }
      const mark = this.mark();
      const property = this.parseObjectTypeProperty();
      if (property) {
        properties.push(property);
      }
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse object type property; skipping token.");
    }
    this.expectText("}", "Expected '}' after object type.");
    return {
      kind: "ObjectType",
      properties,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseObjectTypeProperty(): ObjectTypePropertyNode | null {
    const start = this.current();
    const name = this.parseIdentifier("Expected object type field name.");
    if (!name) {
      this.recoverTypeProperty();
      return null;
    }
    const optional = this.matchText("?");
    this.expectText(":", "Expected ':' after object type field name.");
    const typeAnnotation = this.isUnexpectedDeclarationBoundary()
      ? this.missingTypeAt(this.current())
      : this.parseType();
    return {
      kind: "ObjectTypeProperty",
      name,
      optional,
      typeAnnotation,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private recoverTypeProperty(): void {
    while (
      !this.isAtEnd()
      && this.current().text !== "}"
      && this.current().text !== ","
      && this.current().text !== ";"
      && !this.isStatementBoundary(this.current())
    ) {
      this.advance();
    }
  }

  private isUnexpectedDeclarationBoundary(): boolean {
    return this.isStatementBoundary(this.current()) && isTopLevelKeyword(this.current().text);
  }

  private looksLikeObjectTypeProperty(): boolean {
    if (this.current().kind !== "identifier" && this.current().kind !== "keyword") {
      return false;
    }
    const separatorOffset = this.peekText(1) === "?" ? 2 : 1;
    return this.peekText(separatorOffset) === ":";
  }

  protected missingTypeAt(token: RsglToken): TypeNode {
    this.addDiagnosticAtCurrent("rsgl.expectedType", "Expected type.");
    return {
      kind: "MissingType",
      ...this.nodeRanges(token, token)
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

  protected parseNumberLiteral(): NumberLiteralNode {
    const token = this.advance();
    return {
      kind: "NumberLiteral",
      value: token.text.startsWith("0x") || token.text.startsWith("0X")
        ? Number.parseInt(token.text.slice(2), 16)
        : Number(token.text),
      raw: token.text,
      ...this.nodeRanges(token, token)
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
    return {
      kind: "Identifier",
      text,
      range: getNodeOrTokenRange(token),
      fullRange: getNodeOrTokenFullRange(token)
    };
  }

  protected booleanLiteral(token: RsglToken, value: boolean): BooleanLiteralNode {
    return {
      kind: "BooleanLiteral",
      value,
      ...this.nodeRanges(token, token)
    };
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

  protected nodeRanges(start: RsglToken, end: RsglToken): Pick<RsglNode, "range" | "fullRange"> {
    return {
      range: { start: start.offset, end: end.offset + end.length },
      fullRange: { start: this.fullStart(start), end: end.offset + end.length }
    };
  }

  protected fullStart(token: RsglToken): number {
    return token.leadingTrivia.length > 0 ? token.leadingTrivia[0].offset : token.offset;
  }

  protected peek(ahead: number): RsglToken {
    return this.tokens[this.tokenOffset() + ahead] ?? this.current();
  }

  protected peekText(ahead: number): string {
    return this.peek(ahead).text;
  }

  protected peekKind(ahead: number): RsglToken["kind"] {
    return this.peek(ahead).kind;
  }

  protected tokenOffset(): number {
    const current = this.current();
    return this.tokens.indexOf(current);
  }
}

export function getNodeOrTokenRange(value: RsglToken | RsglNode): TextRange {
  return "range" in value ? value.range : tokenRange(value);
}

export function getNodeOrTokenFullRange(value: RsglToken | RsglNode): TextRange {
  return "fullRange" in value ? value.fullRange : tokenRange(value);
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
