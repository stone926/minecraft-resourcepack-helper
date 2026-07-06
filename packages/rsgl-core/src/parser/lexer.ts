import { isMinecraftResourceLocationText } from "../../../mc-assets/src";
import { rsglKeywords } from "./keywords";
import { LexResult, RsglDiagnostic, RsglToken, RsglTokenKind, Trivia } from "./types";

const twoCharacterOperators = new Set(["->", "==", "!=", "<=", ">=", "&&", "||", ".."]);
const singleCharacterOperators = new Set(["=", "?", ":", "+", "-", "*", "/", "%", "!", "<", ">", "|"]);
const punctuationCharacters = new Set(["{", "}", "[", "]", "(", ")", ",", ".", ";", "@"]);

export function lexRsgl(text: string): LexResult {
  const lexer = new RsglLexer(text);
  return lexer.lex();
}

class RsglLexer {
  private readonly tokens: RsglToken[] = [];
  private readonly diagnostics: RsglDiagnostic[] = [];
  private offset = 0;

  public constructor(private readonly text: string) { }

  public lex(): LexResult {
    while (!this.isAtEnd()) {
      const leadingTrivia = this.readTrivia();
      if (this.isAtEnd()) {
        break;
      }

      const token = this.readToken(leadingTrivia);
      this.tokens.push(token);
    }

    this.tokens.push({
      kind: "endOfFile",
      text: "",
      offset: this.text.length,
      length: 0,
      leadingTrivia: this.readTrivia()
    });

    return {
      tokens: this.tokens,
      diagnostics: this.diagnostics
    };
  }

  private readTrivia(): Trivia[] {
    const trivia: Trivia[] = [];
    let reading = true;

    while (reading && !this.isAtEnd()) {
      const start = this.offset;
      const char = this.peek();
      if (char === " " || char === "\t") {
        while (!this.isAtEnd() && (this.peek() === " " || this.peek() === "\t")) {
          this.offset++;
        }
        trivia.push(this.createTrivia("whitespace", start));
      } else if (char === "\r" || char === "\n") {
        this.readNewline();
        trivia.push(this.createTrivia("newline", start));
      } else if (this.startsWith("//")) {
        this.offset += 2;
        while (!this.isAtEnd() && this.peek() !== "\r" && this.peek() !== "\n") {
          this.offset++;
        }
        trivia.push(this.createTrivia("lineComment", start));
      } else if (this.startsWith("/*")) {
        this.offset += 2;
        while (!this.isAtEnd() && !this.startsWith("*/")) {
          this.offset++;
        }
        if (this.startsWith("*/")) {
          this.offset += 2;
        } else {
          this.diagnostics.push(this.createDiagnostic(
            "rsgl.unterminatedBlockComment",
            "Unterminated block comment.",
            start,
            this.offset
          ));
        }
        trivia.push(this.createTrivia("blockComment", start));
      } else {
        reading = false;
      }
    }

    return trivia;
  }

  private readToken(leadingTrivia: Trivia[]): RsglToken {
    const start = this.offset;
    const char = this.peek();

    if (char === "\"") {
      return this.readStringToken(start, leadingTrivia);
    }

    if (char === "`") {
      return this.readTemplateStringToken(start, leadingTrivia);
    }

    if (isIdentifierStart(char)) {
      return this.readIdentifierLikeToken(start, leadingTrivia);
    }

    if (isDigit(char)) {
      return this.readNumberToken(start, leadingTrivia);
    }

    const twoCharacters = this.text.slice(this.offset, this.offset + 2);
    if (twoCharacterOperators.has(twoCharacters)) {
      this.offset += 2;
      return this.createToken("operator", start, leadingTrivia);
    }

    if (singleCharacterOperators.has(char)) {
      this.offset++;
      return this.createToken("operator", start, leadingTrivia);
    }

    if (punctuationCharacters.has(char)) {
      this.offset++;
      return this.createToken("punctuation", start, leadingTrivia);
    }

    this.offset++;
    this.diagnostics.push(this.createDiagnostic(
      "rsgl.invalidCharacter",
      `Unexpected character '${char}'.`,
      start,
      this.offset
    ));
    return this.createToken("invalid", start, leadingTrivia);
  }

  private readIdentifierLikeToken(start: number, leadingTrivia: Trivia[]): RsglToken {
    while (!this.isAtEnd() && isIdentifierPart(this.peek())) {
      this.offset++;
    }

    if (this.peek() === ":" && isResourcePathCharacter(this.peek(1))) {
      this.offset++;
      while (!this.isAtEnd() && isResourcePathCharacter(this.peek())) {
        this.offset++;
      }
      const text = this.text.slice(start, this.offset);
      const kind: RsglTokenKind = isMinecraftResourceLocationText(text) ? "resourceLocation" : "identifier";
      return this.createToken(kind, start, leadingTrivia);
    }

    const value = this.text.slice(start, this.offset);
    return this.createToken(rsglKeywords.has(value) ? "keyword" : "identifier", start, leadingTrivia);
  }

  private readNumberToken(start: number, leadingTrivia: Trivia[]): RsglToken {
    if (this.startsWith("0x") || this.startsWith("0X")) {
      this.offset += 2;
      while (!this.isAtEnd() && /[0-9a-fA-F]/.test(this.peek())) {
        this.offset++;
      }
      return this.createToken("number", start, leadingTrivia);
    }

    while (!this.isAtEnd() && isDigit(this.peek())) {
      this.offset++;
    }

    if (this.peek() === "." && this.peek(1) !== "." && isDigit(this.peek(1))) {
      this.offset++;
      while (!this.isAtEnd() && isDigit(this.peek())) {
        this.offset++;
      }
    }

    return this.createToken("number", start, leadingTrivia);
  }

  private readStringToken(start: number, leadingTrivia: Trivia[]): RsglToken {
    this.offset++;
    let terminated = false;

    while (!this.isAtEnd()) {
      const char = this.peek();
      if (char === "\"") {
        this.offset++;
        terminated = true;
        break;
      }

      if (char === "\\") {
        this.offset += this.offset + 1 < this.text.length ? 2 : 1;
        continue;
      }

      if (char === "\r" || char === "\n") {
        break;
      }

      this.offset++;
    }

    if (!terminated) {
      this.diagnostics.push(this.createDiagnostic(
        "rsgl.unterminatedString",
        "Unterminated string literal.",
        start,
        this.offset
      ));
    }

    return this.createToken("string", start, leadingTrivia);
  }

  private readTemplateStringToken(start: number, leadingTrivia: Trivia[]): RsglToken {
    this.offset++;
    let terminated = false;

    while (!this.isAtEnd()) {
      const char = this.peek();
      if (char === "`") {
        this.offset++;
        terminated = true;
        break;
      }

      if (char === "\\") {
        this.offset += this.offset + 1 < this.text.length ? 2 : 1;
      } else {
        this.offset++;
      }
    }

    if (!terminated) {
      this.diagnostics.push(this.createDiagnostic(
        "rsgl.unterminatedTemplateString",
        "Unterminated template string.",
        start,
        this.offset
      ));
    }

    return this.createToken("templateString", start, leadingTrivia);
  }

  private readNewline(): void {
    if (this.startsWith("\r\n")) {
      this.offset += 2;
    } else {
      this.offset++;
    }
  }

  private createToken(kind: RsglTokenKind, start: number, leadingTrivia: Trivia[]): RsglToken {
    return {
      kind,
      text: this.text.slice(start, this.offset),
      offset: start,
      length: this.offset - start,
      leadingTrivia
    };
  }

  private createTrivia(kind: Trivia["kind"], start: number): Trivia {
    return {
      kind,
      text: this.text.slice(start, this.offset),
      offset: start,
      length: this.offset - start
    };
  }

  private createDiagnostic(code: string, message: string, start: number, end: number): RsglDiagnostic {
    return {
      code,
      message,
      severity: "error",
      range: {
        start,
        end: Math.max(start + 1, end)
      }
    };
  }

  private startsWith(value: string): boolean {
    return this.text.startsWith(value, this.offset);
  }

  private peek(ahead = 0): string {
    return this.text[this.offset + ahead] ?? "";
  }

  private isAtEnd(): boolean {
    return this.offset >= this.text.length;
  }
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function isDigit(char: string): boolean {
  return /[0-9]/.test(char);
}

function isResourcePathCharacter(char: string): boolean {
  return /[a-z0-9_./-]/.test(char);
}
