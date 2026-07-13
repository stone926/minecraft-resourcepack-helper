import {
  isResourceKeyword,
  isTopLevelKeyword
} from "./keywords";
import { parseExternResourcePattern } from "../externDeclarations";
import { lexRsgl } from "./lexer";
import { tokenRange } from "./parserContext";
import { StatementParser } from "./statementParser";
import {
  BlockNode,
  ExternDeclNode,
  ExternPatternNode,
  ExternResourceSource,
  ExportSpecifierNode,
  ExprNode,
  IdentifierNode,
  ImportSpecifierNode,
  ParameterNode,
  ResourceDeclNode,
  ResourceKind,
  RsglModule,
  RsglToken,
  StringLiteralNode,
  DeclaredTemplateOutputDialect,
  TemplateBodyNode,
  TypeAliasDeclNode,
  TopLevelStatementNode
} from "./types";
import { getRsglResourceKindDescriptor } from "../resourceKinds";
import { binaryPrecedence } from "./statementKeywords";
import {
  concreteResourceBodyParseContext,
  blockstateRootParseContext,
  legacyBlockstateRootParseContext,
  multipartBodyParseContext,
  templateResourceBodyParseContext,
  topLevelBodyParseContext,
  variantsBodyParseContext
} from "./bodyParseContext";
import { legacyTemplateBodyParsePlan } from "./resourceBodyDialectRegistry";

export function parseRsgl(text: string): RsglModule {
  const lexResult = lexRsgl(text);
  const parser = new RsglParser(lexResult.tokens, lexResult.diagnostics);
  return parser.parseModule();
}

class RsglParser extends StatementParser {
  private targetCount = 0;
  private blockDepth = 0;

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
    if (keyword === "type") {
      return this.parseTypeAliasDecl();
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
      return this.parseForStmt(topLevelBodyParseContext);
    }
    if (keyword === "if") {
      return this.parseIfStmt(topLevelBodyParseContext);
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

  protected override parseBlock(): BlockNode {
    this.blockDepth++;
    try {
      return super.parseBlock();
    } finally {
      this.blockDepth--;
    }
  }

  private parseTypeAliasDecl(): TypeAliasDeclNode {
    const start = this.advance();
    if (this.blockDepth > 0) {
      this.addDiagnostic(
        "rsgl.typeAliasMustBeTopLevel",
        "Type aliases may only be declared at module top level.",
        tokenRange(start)
      );
    }
    const name = this.parseIdentifier("Expected type alias name.");
    if (name?.text === "Missing") {
      this.addDiagnostic(
        "rsgl.internalMissingType",
        "Missing is an internal type sentinel and cannot be declared in RSGL source.",
        name.range
      );
    }
    this.expectText("=", "Expected '=' in type alias declaration.");
    const typeAnnotation = this.isAtEnd()
      || this.current().text === "}"
      || (this.isStatementBoundary(this.current()) && isTopLevelKeyword(this.current().text))
      ? this.missingTypeAt(this.current())
      : this.parseType();
    return {
      kind: "TypeAliasDecl",
      keyword: start.text,
      name,
      typeAnnotation,
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
        if (defaultName) {
          this.addDiagnostic(
            "rsgl.unsupportedDefaultImport",
            "Default imports are not supported; use a named import.",
            defaultName.range
          );
        }
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
    const skipExistenceCheck = this.parseExternBang(start);
    if (this.current().text === "var") {
      this.addDiagnostic(
        "rsgl.externVarInvalidContext",
        "'extern var' is only valid directly inside a model resource body.",
        tokenRange(this.current())
      );
    }
    const source = this.parseExternSource();
    const resourceKind = this.parseExternResourceKind();
    const patterns = this.parseExternPatterns();

    return {
      kind: "ExternDecl",
      keyword: start.text,
      source,
      resourceKind,
      patterns,
      skipExistenceCheck,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseExternBang(externToken: RsglToken): boolean {
    if (this.current().text !== "!") {
      return false;
    }

    const bang = this.advance();
    if (bang.offset !== externToken.offset + externToken.length) {
      this.addDiagnostic(
        "rsgl.externBangMustBeAdjacent",
        "The '!' modifier must immediately follow 'extern' without whitespace or comments.",
        tokenRange(bang)
      );
    }
    return true;
  }

  private parseExternSource(): ExternResourceSource | null {
    const token = this.current();
    if (this.isAtEnd() || token.text === "}" || this.isStatementBoundary(token)) {
      this.addDiagnosticAtCurrent(
        "rsgl.invalidExternSource",
        "Expected extern source 'custom' or 'vanilla'."
      );
      return null;
    }
    if (token.text === "custom" || token.text === "vanilla") {
      this.advance();
      return token.text;
    }

    this.addDiagnosticAtCurrent(
      "rsgl.invalidExternSource",
      "Expected extern source 'custom' or 'vanilla'."
    );
    if (token.kind === "identifier" || token.kind === "keyword") {
      this.advance();
    }
    return null;
  }

  private parseExternResourceKind(): IdentifierNode | null {
    const token = this.current();
    if (this.isAtEnd() || token.text === "}" || this.isStatementBoundary(token)) {
      this.addDiagnosticAtCurrent("rsgl.expectedIdentifier", "Expected extern resource kind.");
      return null;
    }
    return this.parseIdentifier("Expected extern resource kind.");
  }

  private parseExternPatterns(): ExternPatternNode[] {
    const patterns: ExternPatternNode[] = [];
    while (!this.isAtEnd() && this.current().text !== "}" && !this.isStatementBoundary(this.current())) {
      const pattern = this.parseExternPattern();
      if (pattern) {
        patterns.push(pattern);
      }
      if (!this.matchText(",")) {
        break;
      }
    }

    if (patterns.length === 0) {
      this.addDiagnosticAtCurrent("rsgl.expectedExternPattern", "Expected at least one extern resource pattern.");
    } else if (this.previousOr(this.current()).text === ",") {
      this.addDiagnosticAtCurrent("rsgl.expectedExternPattern", "Expected an extern resource pattern after ','.");
    }
    return patterns;
  }

  private parseExternPattern(): ExternPatternNode | null {
    const start = this.current();
    if (start.text === "," || start.text === "}" || this.isAtEnd() || this.isStatementBoundary(start)) {
      return null;
    }

    const tokens: RsglToken[] = [];
    while (
      !this.isAtEnd()
      && this.current().text !== ","
      && this.current().text !== "}"
      && !this.isStatementBoundary(this.current())
    ) {
      tokens.push(this.advance());
    }

    const end = tokens[tokens.length - 1] ?? start;
    const pattern: ExternPatternNode = {
      kind: "ExternPattern",
      text: tokens.map(token => token.text).join(""),
      ...this.nodeRanges(start, end)
    };
    const containsGap = tokens.slice(1).some(token => token.leadingTrivia.length > 0);
    const parsed = containsGap
      ? { error: "Extern resource patterns must be contiguous text without whitespace or comments." }
      : parseExternResourcePattern(pattern.text);
    if (parsed.error) {
      this.addDiagnostic("rsgl.invalidExternPattern", parsed.error, pattern.range);
    }
    return pattern;
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
    let outputSyntax: "noArrow" | "explicitArrow" = "noArrow";
    let declaredOutputDialect: DeclaredTemplateOutputDialect | undefined;
    if (this.matchText("->")) {
      outputSyntax = "explicitArrow";
      const dialect = this.current();
      if (isTemplateOutputDialect(dialect.text)) {
        declaredOutputDialect = this.advance().text as DeclaredTemplateOutputDialect;
      } else {
        this.addDiagnosticAtCurrent(
          "rsgl.invalidTemplateOutputDialect",
          "Template output dialect must be 'model', 'variants', or 'multipart'."
        );
        if (dialect.kind === "identifier" || dialect.kind === "keyword") {
          this.advance();
        }
      }
    }
    const body = outputSyntax === "explicitArrow" || this.current().text === "{"
      ? this.parseTemplateBody(declaredOutputDialect, outputSyntax)
      : this.emptyBlockAt(this.current(), "Expected template body.");
    return {
      kind: "TemplateDecl",
      keyword: start.text,
      name,
      parameters,
      declaredOutputDialect,
      outputSyntax,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseTemplateBody(
    declaredOutputDialect?: DeclaredTemplateOutputDialect,
    outputSyntax: "noArrow" | "explicitArrow" = "noArrow"
  ): TemplateBodyNode {
    if (outputSyntax === "explicitArrow") {
      if (declaredOutputDialect === "model") {
        return this.parseResourceBody(templateResourceBodyParseContext("model"));
      }
      if (declaredOutputDialect === "variants") {
        const body = this.parseBodyForContext(variantsBodyParseContext);
        if (body.kind !== "VariantBody") {
          throw new Error(`Internal parser invariant: expected VariantBody, received ${body.kind}.`);
        }
        return body;
      }
      if (declaredOutputDialect === "multipart") {
        const body = this.parseBodyForContext(multipartBodyParseContext);
        if (body.kind !== "MultipartBody") {
          throw new Error(`Internal parser invariant: expected MultipartBody, received ${body.kind}.`);
        }
        return body;
      }
      return this.parseBlock();
    }
    const parsePlan = legacyTemplateBodyParsePlan(this.tokens, this.mark());
    if (parsePlan.kind === "resourceBody") {
      if (parsePlan.detectedDialects.length > 1) {
        this.addDiagnostic(
          "rsgl.conflictingLegacyTemplateBodyDialects",
          `Legacy template body mixes incompatible dialects: ${parsePlan.detectedDialects.join(", ")}. Add an explicit public output dialect or split the template.`,
          tokenRange(this.current())
        );
      }
      return this.parseResourceBody(templateResourceBodyParseContext(parsePlan.dialect));
    }
    return this.parseBlock();
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
    if (resourceKind === "blockstate") {
      return this.parseBlockstateResourceDecl(start);
    }
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
      ? this.parseResourceBody(concreteResourceBodyParseContext(resourceKind))
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

  private parseBlockstateResourceDecl(start: RsglToken): ResourceDeclNode {
    if (this.current().text === "variants" || this.current().text === "multipart") {
      const modeToken = this.advance();
      const mode = modeToken.text as "variants" | "multipart";
      const modeNode = this.syntheticIdentifier(modeToken, mode);
      const id = this.parseBlockstateResourceId();
      const body = this.parseBodyForContext(blockstateRootParseContext(mode));
      if (mode === "variants") {
        if (body.kind !== "BlockstateVariantsRootBody") {
          throw new Error("Parser invariant: variants header must produce a variants root body.");
        }
        return {
          kind: "ResourceDecl",
          keyword: start.text,
          resourceKind: "blockstate",
          blockstateSyntax: "modeHeader",
          mode,
          modeNode,
          id,
          body,
          ...this.nodeRanges(start, this.previousOr(start))
        };
      }
      if (body.kind !== "BlockstateMultipartRootBody") {
        throw new Error("Parser invariant: multipart header must produce a multipart root body.");
      }
      return {
        kind: "ResourceDecl",
        keyword: start.text,
        resourceKind: "blockstate",
        blockstateSyntax: "modeHeader",
        mode,
        modeNode,
        id,
        body,
        ...this.nodeRanges(start, this.previousOr(start))
      };
    }

    let blockstateSyntax: "legacyMissingMode" | "invalidMode" = "legacyMissingMode";
    let modeNode: IdentifierNode | undefined;
    if (!this.isStatementBoundary(this.current()) && this.looksLikeUnknownBlockstateMode()) {
      const token = this.advance();
      modeNode = this.syntheticIdentifier(token, token.text);
      blockstateSyntax = "invalidMode";
      this.addDiagnostic(
        "rsgl.unknownBlockstateMode",
        `Unknown blockstate mode '${token.text}'. Expected 'variants' or 'multipart'.`,
        tokenRange(token)
      );
    } else {
      this.addDiagnostic(
        "rsgl.blockstateModeRequired",
        "Blockstate declarations must specify 'variants' or 'multipart' before the resource id.",
        tokenRange(this.current()),
        "warning"
      );
    }
    const id = this.parseBlockstateResourceId();
    const body = this.parseBodyForContext(legacyBlockstateRootParseContext);
    if (body.kind !== "LegacyBlockstateRootBody") {
      throw new Error("Parser invariant: a legacy blockstate header must produce a legacy root body.");
    }
    return {
      kind: "ResourceDecl",
      keyword: start.text,
      resourceKind: "blockstate",
      blockstateSyntax,
      mode: null,
      modeNode,
      id,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseBlockstateResourceId(): ExprNode {
    if (this.current().text === "{" || this.isAtEnd() || this.isStatementBoundary(this.current())) {
      this.addDiagnosticAtCurrent("rsgl.expectedBlockstateId", "Expected blockstate resource id.");
      return this.missingExprAt(this.current());
    }
    return this.parseExpression({ stopTexts: ["{"] });
  }

  private looksLikeUnknownBlockstateMode(): boolean {
    const token = this.current();
    if (token.kind !== "identifier" && token.kind !== "keyword") {
      return false;
    }
    const next = this.peekText(1);
    return next !== ""
      && next !== "{"
      && !isBlockstateIdExpressionContinuation(next);
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

function isBlockstateIdExpressionContinuation(text: string): boolean {
  return text === "("
    || text === "["
    || text === "."
    || text === "?"
    || text === "in"
    || text === "=>"
    || binaryPrecedence.has(text);
}

function isTemplateOutputDialect(text: string): text is DeclaredTemplateOutputDialect {
  return text === "model" || text === "variants" || text === "multipart";
}
