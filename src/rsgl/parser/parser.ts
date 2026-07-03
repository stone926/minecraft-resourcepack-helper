import {
  isResourceKeyword,
  isSugarKeyword,
  isTopLevelKeyword
} from "./keywords";
import { lexRsgl } from "./lexer";
import { endRange, ParserContext, tokenRange } from "./parserContext";
import { RsglModule, RsglStatement } from "./types";

const resourceBodySectionKeywords = new Set([
  "variants",
  "multipart",
  "textures",
  "animation",
  "sources",
  "filter",
  "raw",
  "override",
  "append"
]);

const resourceBodyControlKeywords = new Set(["use", "for", "if", "when"]);

export function parseRsgl(text: string): RsglModule {
  const lexResult = lexRsgl(text);
  const parser = new RsglParser(lexResult.tokens, lexResult.diagnostics);
  return parser.parseModule();
}

class RsglParser extends ParserContext {
  private targetCount = 0;

  public parseModule(): RsglModule {
    const statements: RsglStatement[] = [];
    while (!this.isAtEnd()) {
      if (this.current().text === "}") {
        const token = this.advance();
        this.addDiagnostic("rsgl.unexpectedClosingBrace", "Unexpected closing brace.", tokenRange(token));
        continue;
      }

      statements.push(this.parseStatement());
    }

    const eof = this.current();
    return {
      kind: "Module",
      statements,
      eof,
      diagnostics: this.diagnostics,
      tokens: this.tokens,
      range: { start: 0, end: eof.offset },
      fullRange: { start: 0, end: eof.offset }
    };
  }

  private parseStatement(): RsglStatement {
    const startToken = this.current();
    const keyword = startToken.text;

    if (keyword === "target") {
      return this.parseTargetDecl();
    }

    if (keyword === "namespace") {
      return this.parseSimpleValueDecl("NamespaceDecl", "Expected namespace name.");
    }

    if (keyword === "import") {
      return this.parseImportDecl();
    }

    if (keyword === "let") {
      return this.parseLetDecl();
    }

    if (keyword === "table") {
      return this.parseNamedBlockDecl("TableDecl", "Expected table name.");
    }

    if (keyword === "template") {
      return this.parseTemplateDecl();
    }

    if (isResourceKeyword(keyword)) {
      return this.parseResourceDecl();
    }

    if (isSugarKeyword(keyword)) {
      return this.parseSugarDecl();
    }

    if (keyword === "use") {
      return this.parseLineOrBlockStatement("UseDecl");
    }

    if (keyword === "for") {
      return this.parseForOrIfStatement("ForStmt");
    }

    if (keyword === "if") {
      return this.parseForOrIfStatement("IfStmt");
    }

    this.addDiagnostic(
      "rsgl.unexpectedToken",
      `Unexpected token '${startToken.text}'.`,
      tokenRange(startToken)
    );
    this.recoverToNextStatement();
    return this.createStatement("UnknownStmt", keyword, startToken, this.previousOr(startToken));
  }

  private parseTargetDecl(): RsglStatement {
    const startToken = this.advance();
    this.targetCount++;
    if (this.targetCount > 1) {
      this.addDiagnostic(
        "rsgl.multipleTargets",
        "A compile unit should have only one primary target.",
        tokenRange(startToken),
        "warning"
      );
    }

    this.expectValue("Expected target edition.");
    if (!this.matchText("format") && !this.matchText("mc")) {
      this.addDiagnosticAtCurrent("rsgl.expectedTargetSelector", "Expected target selector 'format' or 'mc'.");
    }
    this.consumeExpressionOnLine("Expected target value.");

    return this.createStatement("TargetDecl", startToken.text, startToken, this.previousOr(startToken));
  }

  private parseSimpleValueDecl(kind: RsglStatement["kind"], expectedMessage: string): RsglStatement {
    const startToken = this.advance();
    this.consumeExpressionOnLine(expectedMessage);
    return this.createStatement(kind, startToken.text, startToken, this.previousOr(startToken));
  }

  private parseImportDecl(): RsglStatement {
    const startToken = this.advance();
    let foundSource = false;

    while (!this.isAtEnd() && !this.isStatementBoundary(this.current())) {
      if (this.current().kind === "string") {
        foundSource = true;
      }
      this.advance();
    }

    if (!foundSource) {
      this.addDiagnostic(
        "rsgl.expectedImportSource",
        "Expected import source string.",
        endRange(this.previousOr(startToken))
      );
    }

    return this.createStatement("ImportDecl", startToken.text, startToken, this.previousOr(startToken));
  }

  private parseLetDecl(): RsglStatement {
    const startToken = this.advance();
    this.expectValue("Expected let binding name.");
    while (!this.isAtEnd() && !this.isStatementBoundary(this.current()) && this.current().text !== "=") {
      this.advance();
    }

    if (!this.matchText("=")) {
      this.addDiagnostic("rsgl.expectedEquals", "Expected '=' in let declaration.", endRange(this.previousOr(startToken)));
      return this.createStatement("LetDecl", startToken.text, startToken, this.previousOr(startToken));
    }

    this.consumeExpressionOnLine("Expected let value.");
    return this.createStatement("LetDecl", startToken.text, startToken, this.previousOr(startToken));
  }

  private parseNamedBlockDecl(kind: RsglStatement["kind"], expectedNameMessage: string): RsglStatement {
    const startToken = this.advance();
    this.expectValue(expectedNameMessage);
    this.consumeBalancedBlock("Expected declaration body.");
    return this.createStatement(kind, startToken.text, startToken, this.previousOr(startToken));
  }

  private parseTemplateDecl(): RsglStatement {
    const startToken = this.advance();
    this.expectValue("Expected template name.");
    if (this.current().text === "(") {
      this.consumeBalancedEnclosure("(", ")", "Expected ')' after template parameters.");
    } else {
      this.addDiagnosticAtCurrent("rsgl.expectedParameters", "Expected template parameter list.");
    }
    this.consumeBalancedBlock("Expected template body.");
    return this.createStatement("TemplateDecl", startToken.text, startToken, this.previousOr(startToken));
  }

  private parseResourceDecl(): RsglStatement {
    const startToken = this.advance();
    const resourceKind = startToken.text;

    if (resourceKind !== "pack") {
      this.consumeResourceHeader(resourceKind);
    }

    this.consumeResourceBody(resourceKind);
    return this.createStatement("ResourceDecl", startToken.text, startToken, this.previousOr(startToken));
  }

  private parseSugarDecl(): RsglStatement {
    const startToken = this.advance();

    if (this.current().text === "[") {
      this.consumeBalancedEnclosure("[", "]", "Expected ']' after batch declaration.");
    } else {
      while (!this.isAtEnd() && !this.isStatementBoundary(this.current()) && this.current().text !== "{" && this.current().text !== "[") {
        this.advance();
      }
      if (this.current().text === "[") {
        this.consumeBalancedEnclosure("[", "]", "Expected ']' after batch declaration.");
      } else if (this.current().text === "{") {
        this.consumeResourceBody(startToken.text);
      }
    }

    return this.createStatement("SugarDecl", startToken.text, startToken, this.previousOr(startToken));
  }

  private parseForOrIfStatement(kind: "ForStmt" | "IfStmt"): RsglStatement {
    const startToken = this.advance();
    while (!this.isAtEnd() && !this.isStatementBoundary(this.current()) && this.current().text !== "{") {
      this.advance();
    }
    this.consumeBalancedBlock(`Expected ${startToken.text} body.`);
    if (kind === "IfStmt" && this.current().text === "else") {
      this.advance();
      this.consumeBalancedBlock("Expected else body.");
    }
    return this.createStatement(kind, startToken.text, startToken, this.previousOr(startToken));
  }

  private parseLineOrBlockStatement(kind: RsglStatement["kind"]): RsglStatement {
    const startToken = this.advance();
    while (!this.isAtEnd() && !this.isStatementBoundary(this.current()) && this.current().text !== "{") {
      this.advance();
    }
    if (this.current().text === "{") {
      this.consumeBalancedBlock("Expected statement body.");
    }
    return this.createStatement(kind, startToken.text, startToken, this.previousOr(startToken));
  }

  private consumeResourceHeader(resourceKind: string): void {
    const minimumValueCount = resourceKind === "model" ? 2 : 1;
    let valueCount = 0;

    while (!this.isAtEnd() && !this.isStatementBoundary(this.current()) && this.current().text !== "{") {
      valueCount++;
      this.advance();
    }

    if (valueCount < minimumValueCount) {
      this.addDiagnosticAtCurrent(
        "rsgl.expectedResourceTarget",
        resourceKind === "model" ? "Expected model subtype and id." : `Expected ${resourceKind} id.`
      );
    }
  }

  private consumeResourceBody(resourceKind: string): void {
    if (this.current().text !== "{") {
      this.addDiagnosticAtCurrent("rsgl.expectedResourceBody", "Expected resource body.");
      return;
    }

    const openToken = this.advance();
    const seenSections = new Set<string>();

    while (!this.isAtEnd() && this.current().text !== "}") {
      const token = this.current();

      if (token.text === "{") {
        this.consumeBalancedBlock("Expected '}' after nested body.");
        continue;
      }

      if (token.text === "variants" || token.text === "multipart") {
        if (resourceKind === "blockstate") {
          seenSections.add(token.text);
          if (seenSections.has("variants") && seenSections.has("multipart")) {
            this.addDiagnostic(
              "rsgl.blockstateSectionConflict",
              "A blockstate body should use either variants or multipart, not both.",
              tokenRange(token),
              "warning"
            );
          }
        }
        this.parseResourceSection();
        continue;
      }

      if (resourceBodySectionKeywords.has(token.text)) {
        this.parseResourceSection();
        continue;
      }

      if (resourceBodyControlKeywords.has(token.text)) {
        this.parseResourceControlStatement();
        continue;
      }

      this.parseResourceProperty();
    }

    if (!this.matchText("}")) {
      this.addDiagnostic("rsgl.expectedClosingBrace", "Expected '}' after resource body.", endRange(openToken));
    }
  }

  private parseResourceSection(): void {
    const startToken = this.advance();
    while (!this.isAtEnd() && !this.isStatementBoundary(this.current()) && this.current().text !== "{") {
      this.advance();
    }

    if (this.current().text === "{") {
      this.consumeResourceBody(startToken.text);
    } else {
      this.consumeExpressionOnLine("Expected section body or value.");
    }
  }

  private parseResourceControlStatement(): void {
    const token = this.advance();
    while (!this.isAtEnd() && !this.isStatementBoundary(this.current()) && this.current().text !== "{") {
      this.advance();
    }

    if (this.current().text === "{") {
      this.consumeResourceBody(token.text);
    } else if (token.text !== "use") {
      this.addDiagnostic("rsgl.expectedControlBody", `Expected ${token.text} body.`, endRange(token));
    }
  }

  private parseResourceProperty(): void {
    const nameToken = this.advance();
    if (this.current().text === "{" || this.current().text === "[") {
      this.consumeBalancedEnclosure(this.current().text, this.current().text === "{" ? "}" : "]", "Expected matching closing delimiter.");
      return;
    }

    if (this.current().text === ":" || this.current().text === "=") {
      this.advance();
    }

    if (this.isAtEnd() || this.current().text === "}" || this.isStatementBoundary(this.current())) {
      this.addDiagnostic("rsgl.expectedPropertyValue", `Expected value for '${nameToken.text}'.`, endRange(nameToken));
      return;
    }

    this.consumeExpressionOnLine("Expected property value.");
  }

  private recoverToNextStatement(): void {
    this.advance();
    while (!this.isAtEnd()) {
      const token = this.current();
      if (token.text === "}" || (this.isStatementBoundary(token) && isTopLevelKeyword(token.text))) {
        return;
      }
      this.advance();
    }
  }
}
