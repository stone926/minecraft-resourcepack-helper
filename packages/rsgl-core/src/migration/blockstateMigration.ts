import type {
  BlockstateResourceDeclNode,
  LegacyBlockstateResourceDeclNode,
  MultipartSectionNode,
  RsglNode,
  RsglToken,
  TextRange,
  VariantsSectionNode
} from "../parser";
import { walkRsglModule } from "../parser/astTraversal";
import type { RsglSemanticModel } from "../semantic";
import { collectBlockstateModeEvidence, type InferredBlockstateMode } from "./blockstateModeEvidence";
import {
  collectLegacyBlockstateSyntaxEdits,
  containsRange,
  createWrapperReplacement,
  findSourceToken,
  tokenEndRange,
  type LegacyBlockstateWrapper
} from "./blockstateSyntaxEdits";
import { collectRootTemplateMigrationChanges } from "./rootTemplateMigration";
import { MigrationSymbolResolution } from "./symbolResolution";
import { sortTextEdits } from "./textEdits";
import type {
  BlockstateMigrationInput,
  MigrationIssue,
  MigrationResult,
  TextEdit
} from "./types";

/**
 * Produces conservative source edits for direct legacy blockstate resources.
 * Mode selection and dynamic-key decisions are made from AST + bound semantic
 * data; source text is used only to preserve trivia and make token-local edits.
 */
export function migrateLegacyBlockstates(input: BlockstateMigrationInput): MigrationResult {
  const { sourceText, module, semanticModel } = input;
  const edits: TextEdit[] = [];
  const issues: MigrationIssue[] = [];
  const symbols = new MigrationSymbolResolution(module);

  collectRootTemplateMigrationChanges(sourceText, semanticModel, symbols, edits, issues);
  walkRsglModule(module, {
    enterStatement(statement) {
      if (
        statement.kind !== "ResourceDecl"
        || statement.resourceKind !== "blockstate"
      ) {
        return;
      }
      if (statement.blockstateSyntax === "modeHeader") {
        migrateModeHeaderResource(
          sourceText,
          module.tokens,
          statement,
          semanticModel,
          symbols,
          edits,
          issues
        );
        return "skipChildren";
      }
      migrateDirectResource(
        sourceText,
        module.tokens,
        statement,
        semanticModel,
        symbols,
        edits,
        issues
      );
      return "skipChildren";
    }
  });

  return { edits: sortTextEdits(edits), issues: sortIssues(issues) };
}

function migrateModeHeaderResource(
  sourceText: string,
  tokens: readonly RsglToken[],
  resource: BlockstateResourceDeclNode,
  semanticModel: RsglSemanticModel,
  symbols: MigrationSymbolResolution,
  edits: TextEdit[],
  issues: MigrationIssue[]
): void {
  const wrappers = collectLegacyWrappers(resource.body.range, semanticModel);
  if (wrappers.some(wrapper => wrapperMode(wrapper) !== resource.mode)) {
    issues.push(modeConflictIssue(
      resource.body.range,
      `The '${resource.mode}' blockstate header conflicts with a nested legacy wrapper; migrate it manually.`
    ));
    return;
  }

  const syntax = collectLegacyBlockstateSyntaxEdits(
    semanticModel.module,
    tokens,
    resource.body.range,
    symbols
  );
  if (syntax.unsupportedRange) {
    issues.push(manualBlockstateApplyIssue(syntax.unsupportedRange));
    return;
  }

  const wrapperEdits: TextEdit[] = [];
  for (const wrapper of wrappers) {
    if (wrappers.some(other => other !== wrapper && containsRange(other.range, wrapper.range))) {
      issues.push(modeSelectionIssue(wrapper.range));
      return;
    }
    const replacement = createWrapperReplacement(sourceText, tokens, wrapper, syntax.edits);
    if (!replacement) {
      issues.push(modeSelectionIssue(wrapper.range));
      return;
    }
    wrapperEdits.push(replacement);
  }
  edits.push(
    ...syntax.edits.filter(edit => !wrappers.some(wrapper => containsRange(wrapper.range, edit.range))),
    ...wrapperEdits
  );
}

function migrateDirectResource(
  sourceText: string,
  tokens: readonly RsglToken[],
  resource: LegacyBlockstateResourceDeclNode,
  semanticModel: RsglSemanticModel,
  symbols: MigrationSymbolResolution,
  edits: TextEdit[],
  issues: MigrationIssue[]
): void {
  if (resource.blockstateSyntax === "invalidMode") {
    issues.push(modeSelectionIssue(resource.body.range));
    return;
  }

  const wrappers = resource.body.statements.filter(isLegacyWrapper);
  const evidence = collectBlockstateModeEvidence(resource.body.range, semanticModel);
  if (evidence.size > 1) {
    issues.push(modeConflictIssue(
      resource.body.range,
      "The legacy blockstate contains conflicting variants and multipart mode evidence; migrate it manually."
    ));
    return;
  }
  if (wrappers.length > 1 || (wrappers.length === 0 && evidence.size === 0)) {
    issues.push(modeSelectionIssue(resource.body.range));
    return;
  }

  const wrapper = wrappers[0];
  const mode = wrapper ? wrapperMode(wrapper) : firstMode(evidence);
  if (!mode) {
    issues.push(modeSelectionIssue(resource.body.range));
    return;
  }
  if (wrapper && evidence.size === 1 && !evidence.has(mode)) {
    issues.push(modeConflictIssue(
      resource.body.range,
      "The legacy blockstate wrapper conflicts with other mode evidence; migrate it manually."
    ));
    return;
  }

  const syntax = collectLegacyBlockstateSyntaxEdits(
    semanticModel.module,
    tokens,
    resource.body.range,
    symbols
  );
  if (syntax.unsupportedRange) {
    issues.push(manualBlockstateApplyIssue(syntax.unsupportedRange));
    return;
  }

  const keyword = findSourceToken(tokens, resource.range.start, resource.id.range.start, "blockstate");
  if (!keyword) {
    issues.push(modeSelectionIssue(resource.range));
    return;
  }
  const headerEdit: TextEdit = { range: tokenEndRange(keyword), newText: ` ${mode}` };

  if (!wrapper) {
    edits.push(headerEdit, ...syntax.edits);
    return;
  }
  const wrapperEdit = createWrapperReplacement(sourceText, tokens, wrapper, syntax.edits);
  if (!wrapperEdit) {
    issues.push(modeSelectionIssue(wrapper.range));
    return;
  }
  edits.push(
    headerEdit,
    ...syntax.edits.filter(edit => !containsRange(wrapper.range, edit.range)),
    wrapperEdit
  );
}

function modeSelectionIssue(range: TextRange): MigrationIssue {
  return {
    code: "blockstateModeSelectionRequired",
    message: "Choose variants or multipart for this legacy blockstate before applying a migration.",
    severity: "warning",
    range
  };
}

function modeConflictIssue(range: TextRange, message: string): MigrationIssue {
  return { code: "blockstateModeConflict", message, severity: "warning", range };
}

function isLegacyWrapper(node: RsglNode): node is LegacyBlockstateWrapper {
  return node.kind === "VariantsSection" || node.kind === "MultipartSection";
}

function wrapperMode(wrapper: VariantsSectionNode | MultipartSectionNode): InferredBlockstateMode {
  return wrapper.kind === "VariantsSection" ? "variants" : "multipart";
}

function firstMode(modes: ReadonlySet<InferredBlockstateMode>): InferredBlockstateMode | undefined {
  return modes.values().next().value;
}

function collectLegacyWrappers(
  range: TextRange,
  semanticModel: RsglSemanticModel
): LegacyBlockstateWrapper[] {
  const wrappers: LegacyBlockstateWrapper[] = [];
  walkRsglModule(semanticModel.module, {
    enterStatement(statement) {
      if (!containsRange(range, statement.range)) {
        return containsRange(statement.range, range) ? undefined : "skipChildren";
      }
      if (isLegacyWrapper(statement)) {
        wrappers.push(statement);
      }
    }
  });
  return wrappers;
}

function manualBlockstateApplyIssue(range: TextRange): MigrationIssue {
  return {
    code: "manualBlockstateApplyMigrationRequired",
    message: "A legacy model apply contains a bare property other than uvlock; migrate that apply expression manually.",
    severity: "warning",
    range
  };
}

function sortIssues(issues: readonly MigrationIssue[]): MigrationIssue[] {
  return [...issues].sort((left, right) =>
    left.range.start - right.range.start
    || left.range.end - right.range.end
    || compareOrdinal(left.code, right.code)
  );
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
