import { RsglPathKeyMap, rsglPathKey } from "../pathIdentity";
import { templateOutputMetadataFingerprint } from "../templateOutput";
import { rsglTypeKey } from "./typeNormalization";
import type { RsglSemanticModel, RsglSymbol } from "./types";

export type RsglValueImportEnvironment = Map<string, Map<string, RsglSymbol>>;

/** Captures linked import semantics so a following bind can infer dependent expressions. */
export function createRsglValueImportEnvironment(
  models: readonly RsglSemanticModel[],
  cyclicComponentByFile: ReadonlyMap<string, string> = new Map()
): RsglValueImportEnvironment {
  return new RsglPathKeyMap(models.map(model => {
    const imports = new Map<string, RsglSymbol>();
    const sourceComponent = cyclicComponentByFile.get(rsglPathKey(model.fileName));
    for (const [name, symbol] of model.scope.symbols) {
      if (
        symbol.kind === "import"
        && !isImportInsideComponent(symbol, sourceComponent, cyclicComponentByFile)
      ) {
        imports.set(name, snapshotSymbol(symbol));
      }
    }
    return [model.fileName, imports] as const;
  }));
}

function isImportInsideComponent(
  symbol: RsglSymbol,
  sourceComponent: string | undefined,
  cyclicComponentByFile: ReadonlyMap<string, string>
): boolean {
  const importedFile = symbol.importBinding?.sourceFile;
  return sourceComponent !== undefined
    && importedFile !== undefined
    && cyclicComponentByFile.get(rsglPathKey(importedFile)) === sourceComponent;
}

export function valueImportBindingsEqual(
  left: ReadonlyMap<string, RsglSymbol> | undefined,
  right: ReadonlyMap<string, RsglSymbol> | undefined
): boolean {
  const leftSize = left?.size ?? 0;
  const rightSize = right?.size ?? 0;
  if (leftSize !== rightSize) {
    return false;
  }
  if (!leftSize) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  for (const [name, leftSymbol] of left) {
    const rightSymbol = right.get(name);
    if (
      !rightSymbol
      || symbolInferenceFingerprint(leftSymbol) !== symbolInferenceFingerprint(rightSymbol)
    ) {
      return false;
    }
  }
  return true;
}

function snapshotSymbol(symbol: RsglSymbol): RsglSymbol {
  return {
    ...symbol,
    ...(symbol.importBinding ? { importBinding: { ...symbol.importBinding } } : {}),
    ...(symbol.finiteDomain ? { finiteDomain: [...symbol.finiteDomain] } : {}),
    ...(symbol.signature
      ? {
          signature: {
            ...symbol.signature,
            parameters: symbol.signature.parameters.map(parameter => ({ ...parameter }))
          }
        }
      : {})
  };
}

function symbolInferenceFingerprint(symbol: RsglSymbol): string {
  const signature = symbol.signature;
  const signatureFingerprint = signature
    ? [
        signature.parameters.map(parameter => [
          parameter.name,
          parameter.optional ? "optional" : "required",
          parameter.rest ? "rest" : "single",
          rsglTypeKey(parameter.type)
        ].join(":")).join(","),
        rsglTypeKey(signature.returnType),
        signature.valueFunction ? "valueFunction" : "callable",
        signature.templateOutput
          ? templateOutputMetadataFingerprint(signature.templateOutput)
          : "value"
      ].join("->")
    : "";
  return [
    symbol.importBinding
      ? `${symbol.importBinding.kind}:${symbol.importBinding.sourceFile ?? "?"}`
      : "local",
    rsglTypeKey(symbol.type),
    signatureFingerprint,
    symbol.finiteDomain?.join(",") ?? ""
  ].join("|");
}
