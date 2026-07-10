import {
  isResourceKeyword,
  isTopLevelKeyword
} from "./keywords";
import { lexRsgl } from "./lexer";
import { tokenRange } from "./parserContext";
import {
  modelGeometryStatementKeywords,
  resourceBodySectionKeywords
} from "./statementKeywords";
import { StatementParser } from "./statementParser";
import {
  BlockNode,
  ExternDeclNode,
  ExportSpecifierNode,
  ExprNode,
  IdentifierNode,
  ImportSpecifierNode,
  ParameterNode,
  ResourceBodyNode,
  ResourceDeclNode,
  ResourceKind,
  RsglModule,
  StringLiteralNode,
  TopLevelStatementNode
} from "./types";
import { getRsglResourceKindDescriptor } from "../resourceKinds";

export function parseRsgl(text: string): RsglModule {
  const lexResult = lexRsgl(text);
  const parser = new RsglParser(lexResult.tokens, lexResult.diagnostics);
  return parser.parseModule();
}

class RsglParser extends StatementParser {
  private targetCount = 0;

  public parseModule(): RsglModule {
    const statements: TopLevelStatementNode[] = [];
    while (!this.isAtEnd()) {
      const mark = this.mark();
      if (this.current().text === "}") {
        const token = this.advance();
        this.addDiagnostic("rsgl.unexpectedClosingBrace", "Unexpected closing brace.", tokenRange(token));
        continue;
      }

      statements.push(this.parseTopLevelStatement());
      this.ensureProgress(mark, "Unable to parse top-level statement; skipping token.");
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

  protected parseTopLevelStatement(): TopLevelStatementNode {
    const token = this.current();
    const keyword = token.text;

    if (keyword === "target") {
      return this.parseTargetDecl();
    }
    if (keyword === "namespace") {
      return this.parseNamespaceDecl();
    }
    if (keyword === "import") {
      return this.parseImportDecl();
    }
    if (keyword === "export") {
      return this.parseExportDecl();
    }
    if (keyword === "extern") {
      return this.parseExternDecl();
    }
    if (keyword === "overlay") {
      return this.parseOverlayDecl();
    }
    if (keyword === "let") {
      return this.parseLetDecl();
    }
    if (keyword === "table") {
      return this.parseTableDecl();
    }
    if (keyword === "template") {
      return this.parseTemplateDecl();
    }
    if (isResourceKeyword(keyword)) {
      return this.parseResourceDecl();
    }
    if (keyword === "use") {
      return this.parseUseDecl();
    }
    if (keyword === "for") {
      return this.parseForStmt("topLevel");
    }
    if (keyword === "if") {
      return this.parseIfStmt("topLevel");
    }

    this.addDiagnostic("rsgl.unexpectedToken", `Unexpected token '${token.text}'.`, tokenRange(token));
    this.recoverToNextStatement();
    return {
      kind: "UnknownStmt",
      keyword,
      ...this.nodeRanges(token, this.previousOr(token))
    };
  }

  private parseTargetDecl(): TopLevelStatementNode {
    const start = this.advance();
    this.targetCount++;
    if (this.targetCount > 1) {
      this.addDiagnostic(
        "rsgl.multipleTargets",
        "A compile unit should have only one primary target.",
        tokenRange(start),
        "warning"
      );
    }

    const edition = this.parseIdentifier("Expected target edition.");
    let selector: "format" | "mc" | null = null;
    if (this.current().text === "format" || this.current().text === "mc") {
      selector = this.advance().text as "format" | "mc";
    } else {
      this.addDiagnosticAtCurrent("rsgl.expectedTargetSelector", "Expected target selector 'format' or 'mc'.");
    }

    const value = this.parseExpression({ stopTexts: [] });
    return {
      kind: "TargetDecl",
      keyword: start.text,
      edition,
      selector,
      value,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseNamespaceDecl(): TopLevelStatementNode {
    const start = this.advance();
    const name = this.parseExpression({ stopTexts: [] });
    return {
      kind: "NamespaceDecl",
      keyword: start.text,
      name,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseOverlayDecl(): TopLevelStatementNode {
    const start = this.advance();
    const directory = this.parseExpression({ stopTexts: ["format", "{"] });
    let formatRange: ExprNode | undefined;
    if (this.matchText("format")) {
      formatRange = this.parseExpression({ stopTexts: ["{"] });
    }
    const body = this.current().text === "{"
      ? this.parseBlock()
      : this.emptyBlockAt(this.current(), "Expected overlay body.");
    return {
      kind: "OverlayDecl",
      keyword: start.text,
      directory,
      formatRange,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseImportDecl(): TopLevelStatementNode {
    const start = this.advance();
    let defaultName: IdentifierNode | undefined;
    const namedImports: ImportSpecifierNode[] = [];
    let source: StringLiteralNode | null = null;

    if (this.current().text === "{") {
      namedImports.push(...this.parseImportSpecifiers());
      this.matchText("from");
    } else if (this.current().kind === "identifier" || this.current().kind === "keyword") {
      if (this.peekText(1) === "from") {
        defaultName = this.parseIdentifier("Expected imported binding.") ?? undefined;
        this.matchText("from");
      }
    }

    if (this.current().kind === "string") {
      source = this.parseStringLiteral();
    } else {
      this.addDiagnosticAtCurrent("rsgl.expectedImportSource", "Expected import source string.");
      this.recoverToLineEnd();
    }

    return {
      kind: "ImportDecl",
      keyword: start.text,
      defaultName,
      namedImports,
      source,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseImportSpecifiers(): ImportSpecifierNode[] {
    const specifiers: ImportSpecifierNode[] = [];
    this.matchText("{");
    while (!this.isAtEnd() && this.current().text !== "}") {
      const mark = this.mark();
      const start = this.current();
      const imported = this.parseIdentifier("Expected import name.");
      let local = imported;
      if (this.matchText("as")) {
        local = this.parseIdentifier("Expected local import name.") ?? imported;
      }
      specifiers.push({
        kind: "ImportSpecifier",
        imported: imported ?? this.syntheticIdentifier(start, ""),
        local: local ?? this.syntheticIdentifier(start, ""),
        ...this.nodeRanges(start, this.previousOr(start))
      });
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse import specifier; skipping token.");
    }
    this.expectText("}", "Expected '}' after import list.");
    return specifiers;
  }

  private parseExportDecl(): TopLevelStatementNode {
    const start = this.advance();
    const specifiers: ExportSpecifierNode[] = [];
    let source: StringLiteralNode | null = null;
    let exportAll = false;
    let expectsSource = false;

    if (this.matchText("*")) {
      exportAll = true;
      expectsSource = true;
      this.matchText("from");
    } else if (this.current().text === "{") {
      specifiers.push(...this.parseExportSpecifiers());
      expectsSource = this.matchText("from");
    } else {
      this.addDiagnosticAtCurrent("rsgl.expectedExportList", "Expected export list or '*'.");
      this.recoverToLineEnd();
    }

    if (expectsSource) {
      if (this.current().kind === "string") {
        source = this.parseStringLiteral();
      } else {
        this.addDiagnosticAtCurrent("rsgl.expectedExportSource", "Expected export source string.");
        this.recoverToLineEnd();
      }
    }

    return {
      kind: "ExportDecl",
      keyword: start.text,
      specifiers,
      source,
      exportAll,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseExternDecl(): ExternDeclNode {
    const start = this.advance();
    const resourceKind = this.parseIdentifier("Expected extern resource kind.");
    let args: ExternDeclNode["args"] = [];
    if (resourceKind && this.current().text === "(") {
      const call = this.finishCallExpression({
        kind: "IdentifierExpr",
        name: resourceKind,
        range: resourceKind.range,
        fullRange: resourceKind.fullRange
      });
      if (call.kind === "CallExpr") {
        args = call.args;
      }
    }

    if (!resourceKind || args.length === 0) {
      if (this.current().text !== "(") {
        this.addDiagnosticAtCurrent("rsgl.expectedExternArguments", "Expected extern argument list.");
      }
    }

    return {
      kind: "ExternDecl",
      keyword: start.text,
      resourceKind,
      args,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseExportSpecifiers(): ExportSpecifierNode[] {
    const specifiers: ExportSpecifierNode[] = [];
    this.matchText("{");
    while (!this.isAtEnd() && this.current().text !== "}") {
      const mark = this.mark();
      const start = this.current();
      const local = this.parseIdentifier("Expected export name.");
      let exported = local;
      if (this.matchText("as")) {
        exported = this.parseIdentifier("Expected exported name.") ?? local;
      }
      specifiers.push({
        kind: "ExportSpecifier",
        local: local ?? this.syntheticIdentifier(start, ""),
        exported: exported ?? this.syntheticIdentifier(start, ""),
        ...this.nodeRanges(start, this.previousOr(start))
      });
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse export specifier; skipping token.");
    }
    this.expectText("}", "Expected '}' after export list.");
    return specifiers;
  }

  private parseTableDecl(): TopLevelStatementNode {
    const start = this.advance();
    const name = this.parseIdentifier("Expected table name.");
    const body = this.current().text === "{"
      ? this.parseObjectExpression()
      : this.emptyObjectAt(this.current(), "Expected table body.");
    return {
      kind: "TableDecl",
      keyword: start.text,
      name,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseTemplateDecl(): TopLevelStatementNode {
    const start = this.advance();
    const name = this.parseIdentifier("Expected template name.");
    const parameters = this.current().text === "(" ? this.parseParameters() : [];
    if (parameters.length === 0 && this.previousOr(start) === start) {
      this.addDiagnosticAtCurrent("rsgl.expectedParameters", "Expected template parameter list.");
    }
    const body = this.current().text === "{"
      ? this.parseTemplateBody()
      : this.emptyBlockAt(this.current(), "Expected template body.");
    return {
      kind: "TemplateDecl",
      keyword: start.text,
      name,
      parameters,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseTemplateBody(): BlockNode | ResourceBodyNode {
    if (this.templateBodyLooksLikeResourceBody()) {
      return this.parseResourceBody("template");
    }
    return this.parseBlock();
  }

  private templateBodyLooksLikeResourceBody(): boolean {
    if (this.current().text !== "{") {
      return false;
    }
    const first = this.peekText(1);
    if (first === "}" || first === "") {
      return false;
    }
    if (first === "variants" || first === "multipart") {
      return true;
    }
    if (this.isResourceStatementStart(first)) {
      return true;
    }
    return !isTopLevelKeyword(first);
  }

  private isResourceStatementStart(text: string): boolean {
    return text === "base"
      || text === "merge"
      || text === "range"
      || text === "select"
      || text === "condition"
      || text === "composite"
      || text === "empty"
      || text === "selected_item"
      || text === "special"
      || modelGeometryStatementKeywords.has(text)
      || resourceBodySectionKeywords.has(text);
  }

  private parseParameters(): ParameterNode[] {
    const parameters: ParameterNode[] = [];
    this.matchText("(");
    while (!this.isAtEnd() && this.current().text !== ")") {
      const mark = this.mark();
      const start = this.current();
      const name = this.parseIdentifier("Expected parameter name.");
      const typeAnnotation = this.matchText(":") ? this.parseType() : undefined;
      const defaultValue = this.matchText("=") ? this.parseExpression({ stopTexts: [",", ")"] }) : undefined;
      parameters.push({
        kind: "Parameter",
        name,
        typeAnnotation,
        defaultValue,
        ...this.nodeRanges(start, this.previousOr(start))
      });
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse parameter; skipping token.");
    }
    this.expectText(")", "Expected ')' after parameters.");
    return parameters;
  }

  private parseResourceDecl(): ResourceDeclNode {
    const start = this.advance();
    const resourceKind = start.text as ResourceKind;
    const descriptor = getRsglResourceKindDescriptor(resourceKind);
    let subtype: IdentifierNode | undefined;
    let id: ExprNode | undefined;
    let impl: ExprNode | undefined;

    if (descriptor?.ast.shape === "model") {
      subtype = this.parseIdentifier("Expected model subtype.") ?? undefined;
      id = this.parseExpression({ stopTexts: ["impl", "{"] });
      if (descriptor.ast.supportsImpl && this.matchText("impl")) {
        impl = this.parseExpression({ stopTexts: ["{"] });
      }
    } else if (descriptor?.ast.shape === "identified") {
      id = this.parseExpression({ stopTexts: ["{"] });
    }

    const body = this.current().text === "{"
      ? this.parseResourceBody(resourceKind, true)
      : this.emptyResourceBodyAt(this.current(), "Expected resource body.");
    return {
      kind: "ResourceDecl",
      keyword: start.text,
      resourceKind,
      subtype,
      id,
      impl,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
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
