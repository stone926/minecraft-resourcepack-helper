import { RsglDiagnostic, RsglStatement, RsglToken, TextRange } from "./types";

export class ParserContext {
  protected readonly diagnostics: RsglDiagnostic[];
  private offset = 0;

  public constructor(
    protected readonly tokens: RsglToken[],
    diagnostics: RsglDiagnostic[]
  ) {
    this.diagnostics = [...diagnostics];
  }

  protected consumeBalancedBlock(message: string): void {
    if (this.current().text !== "{") {
      this.addDiagnosticAtCurrent("rsgl.expectedBody", message);
      return;
    }

    this.consumeBalancedEnclosure("{", "}", "Expected '}' after block.");
  }

  protected consumeBalancedEnclosure(openText: string, closeText: string, message: string): void {
    const openToken = this.current();
    if (!this.matchText(openText)) {
      this.addDiagnosticAtCurrent("rsgl.expectedOpenDelimiter", `Expected '${openText}'.`);
      return;
    }

    let depth = 1;
    while (!this.isAtEnd() && depth > 0) {
      if (this.current().text === openText) {
        depth++;
      } else if (this.current().text === closeText) {
        depth--;
      }
      this.advance();
    }

    if (depth > 0) {
      this.addDiagnostic("rsgl.expectedClosingDelimiter", message, endRange(openToken));
    }
  }

  protected consumeExpressionOnLine(expectedMessage: string): void {
    if (this.isAtEnd() || this.current().text === "}" || this.isStatementBoundary(this.current())) {
      this.addDiagnosticAtCurrent("rsgl.expectedExpression", expectedMessage);
      return;
    }

    let depth = 0;
    while (!this.isAtEnd()) {
      const token = this.current();
      if (depth === 0 && (token.text === "}" || this.isStatementBoundary(token))) {
        break;
      }

      if (token.text === "{" || token.text === "[" || token.text === "(") {
        depth++;
      } else if (token.text === "}" || token.text === "]" || token.text === ")") {
        if (depth === 0) {
          break;
        }
        depth--;
      }

      this.advance();
    }
  }

  protected expectValue(message: string): boolean {
    if (this.isAtEnd() || this.current().text === "}" || this.isStatementBoundary(this.current())) {
      this.addDiagnosticAtCurrent("rsgl.expectedValue", message);
      return false;
    }

    this.advance();
    return true;
  }

  protected isStatementBoundary(token: RsglToken): boolean {
    return token.kind === "endOfFile" || token.leadingTrivia.some(trivia => trivia.kind === "newline");
  }

  protected addDiagnosticAtCurrent(code: string, message: string, severity: RsglDiagnostic["severity"] = "error"): void {
    const token = this.current();
    this.addDiagnostic(code, message, token.kind === "endOfFile" ? endRange(this.previousOr(token)) : tokenRange(token), severity);
  }

  protected addDiagnostic(
    code: string,
    message: string,
    range: TextRange,
    severity: RsglDiagnostic["severity"] = "error"
  ): void {
    this.diagnostics.push({ code, message, severity, range });
  }

  protected createStatement(
    kind: RsglStatement["kind"],
    keyword: string,
    startToken: RsglToken,
    endToken: RsglToken
  ): RsglStatement {
    const start = startToken.offset;
    const leadingStart = startToken.leadingTrivia.length > 0
      ? startToken.leadingTrivia[0].offset
      : start;
    return {
      kind,
      keyword,
      range: {
        start,
        end: tokenRange(endToken).end
      },
      fullRange: {
        start: leadingStart,
        end: tokenRange(endToken).end
      }
    };
  }

  protected matchText(text: string): boolean {
    if (this.current().text !== text) {
      return false;
    }

    this.advance();
    return true;
  }

  protected advance(): RsglToken {
    const token = this.current();
    if (!this.isAtEnd()) {
      this.offset++;
    }
    return token;
  }

  protected previousOr(fallback: RsglToken): RsglToken {
    return this.offset > 0 ? this.tokens[this.offset - 1] : fallback;
  }

  protected current(): RsglToken {
    return this.tokens[this.offset];
  }

  protected isAtEnd(): boolean {
    return this.current().kind === "endOfFile";
  }
}

export function tokenRange(token: RsglToken): TextRange {
  return {
    start: token.offset,
    end: token.offset + token.length
  };
}

export function endRange(token: RsglToken): TextRange {
  const end = token.offset + token.length;
  return {
    start: end,
    end: end + 1
  };
}
