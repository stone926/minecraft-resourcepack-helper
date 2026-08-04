import type { ExprNode, TextRange } from "../parser";
import type { LambdaImpureCall } from "../semantic/lambdaPurity";
import type { RsglType } from "../semantic/types";
import type { BaseDocumentLoader, CompileDependency } from "./base/types";
import type {
  StateNamespaceValue,
  StatePredicateValue,
  StatePropertyValue
} from "./blockstatePredicate";
import type { EvaluationItemBudget } from "./evaluationItemBudget";
import type { EvaluationTraceSession } from "./evaluationTrace";
import type { RsglEvaluatedResourceValue } from "./evaluatedResourceValues";
import type { ExpansionFrame, JsonValue, RsglMapping } from "./ir";
import type { ModuleNamespaceValue } from "./moduleNamespaceValue";

export interface LambdaValue {
  kind: "lambda";
  parameters: string[];
  body: ExprNode;
  context: EvaluationContext;
  /** Contextual function type retained for runtime argument/return boundaries. */
  signature?: {
    parameters: readonly RsglType[];
    returnType: RsglType;
  };
  /** Impure builtin calls found in the body; a non-empty list blocks execution. */
  impureCalls: LambdaImpureCall[];
}

export type EvaluationValue =
  | JsonValue
  | RsglEvaluatedResourceValue
  | LambdaValue
  | ModuleNamespaceValue
  | StateNamespaceValue
  | StatePropertyValue
  | StatePredicateValue
  | undefined;

export interface RawGlobLoadLimits {
  /** Maximum result items the current shared evaluation budget can accept. */
  maxMatches: number;
  /** Maximum filesystem entries a synchronous loader may inspect. */
  maxVisitedEntries: number;
}

export interface RawGlobLimitExceeded {
  kind: "limitExceeded";
}

export type RawGlobLoadResult = string[] | RawGlobLimitExceeded | undefined;
export type RawGlobLoader = (
  pattern: string,
  context: EvaluationContext,
  range: TextRange,
  limits?: RawGlobLoadLimits
) => RawGlobLoadResult;

export interface EvaluationOrigin {
  sourceFile: string;
  sourceRange: TextRange;
}

export interface EvaluationPathOrigin extends EvaluationOrigin {
  generatedPath: string;
}

/** Source ranges inside the expression currently being evaluated. */
export interface EvaluationPathRange {
  generatedPath: string;
  sourceRange: TextRange;
}

export type EvaluationValueIssueKind =
  | "undefined"
  | "lambda"
  | "nonFiniteNumber"
  | "duplicateObjectKey"
  | "invalidObjectKey";

/** Runtime value-shape facts captured without evaluating an expression twice. */
export interface EvaluationValueIssue {
  generatedPath: string;
  kind: EvaluationValueIssueKind;
  sourceRange: TextRange;
  sourceFile?: string;
}

/** One evaluation plus the provenance needed by JSON-path-aware lowerers. */
export interface EvaluationResult {
  value: EvaluationValue;
  origin?: EvaluationOrigin;
  pathOrigins: EvaluationPathOrigin[];
  /** Durable form of the exact executed value syntax across lexical boundaries. */
  selectionPathOrigins: EvaluationPathOrigin[];
  /**
   * Most specific executed syntax that produced each value path. Unlike
   * pathRanges, wrappers such as conditionals do not replace the selected
   * branch. These ranges are local to the current evaluator source file;
   * selectionPathOrigins carries the same semantics across bindings.
   */
  valuePathRanges: EvaluationPathRange[];
  pathRanges: EvaluationPathRange[];
  valueIssues: EvaluationValueIssue[];
}

export interface EvaluationContext {
  namespace: string;
  variables: Map<string, EvaluationValue>;
  /** Shared collection-expansion accounting for the current compile run. */
  evaluationItemBudget?: EvaluationItemBudget;
  /** Semantic contextual-type facts for AST nodes owned by this module. */
  resolvedExpectedTypes?: ReadonlyMap<ExprNode, RsglType>;
  /** Prevents repeated O(n) predicate preflights during one recursive evaluation. */
  evaluatingStatePredicate?: boolean;
  /** Lexically bound value names, including predeclared bindings not evaluated yet. */
  valueBindingNames?: ReadonlySet<string>;
  /** Lexical origins of values bound from template call arguments. */
  valueOrigins?: ReadonlyMap<string, EvaluationOrigin>;
  /** JSON-pointer-level origins for structured lexical values. */
  valuePathOrigins?: ReadonlyMap<string, readonly EvaluationPathOrigin[]>;
  /** Exact selected value syntax retained separately from diagnostic provenance. */
  valueSelectionPathOrigins?: ReadonlyMap<string, readonly EvaluationPathOrigin[]>;
  /** Runtime value-shape issues retained across lexical bindings. */
  valueIssues?: ReadonlyMap<string, readonly EvaluationValueIssue[]>;
  sourceFile?: string;
  mappingReason?: RsglMapping["reason"];
  expansionStack?: ExpansionFrame[];
  baseDocumentLoader?: BaseDocumentLoader;
  globLoader?: RawGlobLoader;
  onDependency?: (dependency: CompileDependency) => void;
  onError?: (code: string, message: string, range: TextRange, fileName?: string) => void;
  /** @internal Signals that evaluation failed even when semantic analysis owns the diagnostic. */
  onEvaluationFailure?: () => void;
  /** @internal Marks a typed resource-value failure as fatal for the enclosing resource transaction. */
  onResourceValueFailure?: () => void;
  /** @internal Active only for one evaluateExpressionResult call. */
  evaluationTrace?: EvaluationTraceSession;
}
