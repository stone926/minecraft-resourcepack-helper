/**
 * Diagnostic and failure message texts shared verbatim across modules.
 * Parsing, semantic checking, compiler lowering, and materialization must
 * report the same wording for the same condition; tests assert these strings
 * literally, so a change here is a deliberate cross-phase wording change.
 */

/** Blockstate model `with { ... }` option diagnostics (semantic + compiler + parser). */
export const blockstateModelOptionMessages = {
  spreadNotAllowed:
    "A blockstate 'with' block only accepts explicit x, y, z, and uvlock fields.",
  weightOutsideRandomChoice:
    "weight is only valid after an option inside a random choice.",
  duplicateOption: (name: string): string =>
    `Blockstate model option '${name}' is specified more than once.`,
  unknownOption: (name: string): string =>
    `Unknown blockstate model option '${name}'.`,
  invalidRotation: (name: string): string =>
    `Blockstate model ${name} rotation must be one of 0, 90, 180, or 270.`
} as const;

/** Blockstate `variants`/`multipart` root shape diagnostics (merge + JSON validation). */
export const blockstateRootMessages = {
  variantsMustBeObject: "Blockstate root field 'variants' must be an object.",
  multipartMustBeArray: "Blockstate root field 'multipart' must be an array."
} as const;

/** Blockstate variant selector diagnostics (semantic checker + lowerer). */
export const blockstateSelectorMessages = {
  emptySelectorUseWildcard: "An empty variants selector must be written as 'case *'.",
  computedKeyMustBeScalar: "A computed blockstate selector key must evaluate to a scalar value."
} as const;

/** Neutral blockstate state-record diagnostics shared by semantic checking and lowering. */
export const blockstateStateRecordMessages = {
  selectorValueMustBeScalar:
    "Blockstate selector values must be scalar strings, numbers, or booleans.",
  multipartValueMustBeScalar:
    "Multipart state record values must be scalar strings, numbers, or booleans.",
  multipartComputedKeyMustBeScalar:
    "A computed multipart state record key must evaluate to a scalar value.",
  multipartMustBeObject:
    "A multipart state record condition must evaluate to an object.",
  emptyMultipartUseAlways:
    "An empty multipart state record must be written as 'part always'.",
  selectorSpreadMustBeVerifiable:
    "A blockstate selector spread must have a closed, statically verifiable object type.",
  multipartSpreadMustBeVerifiable:
    "A multipart state record spread must have a closed, statically verifiable object type.",
  multipartRawLogicalKey:
    "Multipart state records cannot use raw 'OR' or 'AND' keys; use a StatePredicate for complex conditions.",
  multipartRawEncodedValue:
    "Multipart state records cannot use raw '|' or '!' condition encoding; use a StatePredicate for complex conditions."
} as const;

/** State-predicate misuse diagnostics (semantic checker + compile-time evaluation). */
export const statePredicateMessages = {
  compileTimeCondition:
    "StatePredicate describes runtime block state and cannot control compile-time if/conditional execution."
} as const;

/** Resource-body content diagnostics (semantic checkers + compiler lowering). */
export const resourceBodyMessages = {
  useRequiresTemplateCallOrHelper:
    "use requires a template call or a registered resource-body helper.",
  mergeMustBeObjectFragment: "merge must evaluate to an object fragment.",
  textureVariableOutsideModelSink: "Texture variables are only valid in model texture sinks."
} as const;

/** Call-argument diagnostics (call checking + import validation). */
export const callArgumentMessages = {
  namedArgumentsRequireSignature:
    "Named arguments require a concrete let-bound function signature."
} as const;

/** Extern declaration syntax diagnostics shared by both statement parsers. */
export const externSyntaxMessages = {
  externVarOutsideModelBody: "'extern var' is only valid directly inside a model resource body.",
  bangMustFollowExtern:
    "The '!' modifier must immediately follow 'extern' without whitespace or comments."
} as const;

/** Balanced-block parsing diagnostics shared across parser hosts. */
export const blockSyntaxMessages = {
  expectedCloseAfterBlock: "Expected '}' after block."
} as const;

/** Pack overlay directory diagnostics (declaration compiler + metadata validation). */
export const packOverlayMessages = {
  invalidOverlayDirectory:
    "Overlay directory must contain only lowercase letters, numbers, '_' or '-'."
} as const;

/** Cancellation texts shared by the sync and async materialization transactions. */
export const materializationCancellationMessages = {
  cancelled: "Materialization was cancelled.",
  cancelledBeforeStaging: "Materialization was cancelled before staging.",
  cancelledBeforeCommit: "Materialization was cancelled before commit."
} as const;
