import type {
  ItemModelNode,
  RsglNode,
  RsglStatement,
  RsglStatementBodyNode,
  TextRange,
} from "./parser";
import { walkRsglModule } from "./parser/astTraversal";
import type { RsglSemanticModel, RsglSymbol } from "./semantic";

interface LexicalOwner {
  /** The source region in which the binding can be referenced. */
  range: TextRange;
  /** Local lets become visible only after their declaration has finished. */
  visibleAfter: number;
}

interface VisibilityIndex {
  owners: ReadonlyMap<RsglNode, LexicalOwner>;
}

interface VisibleCandidate {
  symbol: RsglSymbol;
  owner?: LexicalOwner;
}

const visibilityIndexes = new WeakMap<RsglSemanticModel, VisibilityIndex>();

/**
 * Returns the value symbols visible at a source offset without exposing parser
 * or editor protocol details. Global bindings keep the semantic model's
 * existing rules; local bindings must be owned by a containing lexical region.
 */
export function visibleRsglSymbolsAtOffset(
  model: RsglSemanticModel,
  offset: number
): RsglSymbol[] {
  const index = visibilityIndex(model);
  const selected = new Map<string, VisibleCandidate>();

  for (const symbol of model.symbols) {
    const owner = symbol.node ? index.owners.get(symbol.node) : undefined;
    const isGlobal = model.scope.symbols.get(symbol.name) === symbol;
    if (!isGlobal && (!owner || !isVisibleAt(owner, offset))) {
      continue;
    }

    const candidate = { symbol, owner: isGlobal ? undefined : owner };
    const existing = selected.get(symbol.name);
    if (!existing || isMoreLocal(candidate, existing)) {
      selected.set(symbol.name, candidate);
    }
  }

  return [...selected.values()].map(candidate => candidate.symbol);
}

function visibilityIndex(model: RsglSemanticModel): VisibilityIndex {
  const cached = visibilityIndexes.get(model);
  if (cached) {
    return cached;
  }

  const owners = new Map<RsglNode, LexicalOwner>();
  for (const statement of model.module.statements) {
    indexNestedScopes(statement, owners);
  }

  // Lambda scopes can occur in any expression position. The AST walker keeps
  // this independent from the growing set of statement-specific expressions.
  walkRsglModule(model.module, {
    enterExpression(expression) {
      if (expression.kind !== "LambdaExpr") {
        return;
      }
      const owner = lexicalOwner(expression.body.range);
      for (const parameter of expression.parameters) {
        owners.set(parameter, owner);
      }
    }
  });

  const created = { owners };
  visibilityIndexes.set(model, created);
  return created;
}

function indexBody(body: RsglStatementBodyNode, owners: Map<RsglNode, LexicalOwner>): void {
  const region = lexicalOwner(body.range);
  for (const statement of body.statements) {
    if (statement.kind === "LetDecl") {
      owners.set(statement, {
        range: region.range,
        visibleAfter: statement.range.end
      });
    } else if (
      statement.kind === "TableDecl"
      || statement.kind === "TemplateDecl"
      || statement.kind === "ResourceDecl"
    ) {
      // Blocks containing top-level declarations are predeclared by the
      // binder. Preserve that behavior while keeping the declaration local to
      // its containing body.
      owners.set(statement, region);
    }
    indexNestedScopes(statement, owners);
  }
}

function indexNestedScopes(
  statement: RsglStatement,
  owners: Map<RsglNode, LexicalOwner>
): void {
  switch (statement.kind) {
    case "TemplateDecl": {
      const owner = lexicalOwner(statement.body.range);
      for (const parameter of statement.parameters) {
        owners.set(parameter, owner);
      }
      indexBody(statement.body, owners);
      break;
    }
    case "ResourceDecl":
      indexBody(statement.body, owners);
      break;
    case "OverlayDecl":
      indexBody(statement.body, owners);
      break;
    case "ForStmt": {
      const owner = lexicalOwner(statement.body.range);
      for (const dimension of statement.dimensions) {
        for (const binding of dimension.bindings) {
          owners.set(binding, owner);
        }
      }
      indexBody(statement.body, owners);
      break;
    }
    case "IfStmt":
      indexBody(statement.thenBody, owners);
      if (statement.elseBody) {
        indexBody(statement.elseBody, owners);
      }
      break;
    case "BlockstateVariantEntry":
    case "BlockstateMultipartEntry":
      if (statement.choice.kind === "BlockstateRandomChoice") {
        indexBody(statement.choice.body, owners);
      }
      break;
    case "SectionStmt":
      if (statement.body) {
        indexBody(statement.body, owners);
      }
      break;
    case "PackOverlayStmt":
    case "AtlasPalettedPermutationsStmt":
    case "ModelTransformStmt":
      indexBody(statement.body, owners);
      break;
    case "ItemModelProducerStmt":
      indexItemModelNode(statement.value, owners);
      break;
    case "ItemSelectCase":
    case "ItemRangeEntry":
    case "ItemFallbackClause":
    case "ItemCompositeModel":
    case "ItemFirstMatchWhen":
      indexItemModelNode(statement.model, owners);
      break;
    case "ItemRangeFrames":
      // `index` and `frame` are synthetic bindings scoped to the complete nested model.
      owners.set(statement, lexicalOwner(statement.model.range));
      indexItemModelNode(statement.model, owners);
      break;
    default:
      break;
  }
}

function indexItemModelNode(
  model: ItemModelNode,
  owners: Map<RsglNode, LexicalOwner>
): void {
  switch (model.kind) {
    case "ItemModelRange":
    case "ItemModelSelect":
    case "ItemModelComposite":
    case "ItemModelFirstMatch":
      indexBody(model.body, owners);
      break;
    case "ItemModelCondition":
      if (model.onTrue) {
        indexItemModelNode(model.onTrue, owners);
      }
      if (model.onFalse) {
        indexItemModelNode(model.onFalse, owners);
      }
      break;
    case "ItemModelExpr":
    case "ItemModelUse":
    case "ItemModelSpecial":
    case "ItemModelEmpty":
    case "ItemModelSelectedItem":
      break;
  }
}

function lexicalOwner(range: TextRange): LexicalOwner {
  return { range, visibleAfter: range.start };
}

function isVisibleAt(owner: LexicalOwner, offset: number): boolean {
  return owner.range.start <= offset
    && offset <= owner.range.end
    && owner.visibleAfter <= offset;
}

function isMoreLocal(candidate: VisibleCandidate, existing: VisibleCandidate): boolean {
  if (!candidate.owner) {
    return false;
  }
  if (!existing.owner) {
    return true;
  }
  const candidateSpan = candidate.owner.range.end - candidate.owner.range.start;
  const existingSpan = existing.owner.range.end - existing.owner.range.start;
  if (candidateSpan !== existingSpan) {
    return candidateSpan < existingSpan;
  }
  return candidate.owner.visibleAfter > existing.owner.visibleAfter;
}
