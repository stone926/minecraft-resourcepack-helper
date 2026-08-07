import type { RsglGenericJsonResourceKind } from "./resourceKinds";
import {
  booleanType,
  jsonType,
  numberType,
  RsglGenericParameter,
  RsglSignature,
  RsglType,
  stringType
} from "./semantic/types";

/**
 * Layers a collection builtin participates in.
 * - "infer": semantic result-type inference in semantic/collectionBuiltinInference.ts
 * - "eval": collection-path runtime evaluation in compiler/collectionBuiltins.ts
 */
export type RsglCollectionBuiltinLayer = "infer" | "eval";

/** Handler keys implemented by semantic/collectionBuiltinInference.ts. */
export type RsglCollectionInferHandler =
  | "asList"
  | "length"
  | "map"
  | "filter"
  | "flatMap"
  | "flat"
  | "concat"
  | "join"
  | "entries"
  | "keys"
  | "values"
  | "mergeObjects"
  | "has"
  | "product";

/** Handler keys implemented by compiler/collectionBuiltins.ts. */
export type RsglCollectionEvalHandler =
  | "asList"
  | "length"
  | "map"
  | "filter"
  | "flatMap"
  | "flat"
  | "concat"
  | "join"
  | "entries"
  | "keys"
  | "values"
  | "mergeObjects"
  | "product";

/** Handler keys implemented by compiler/jsonResourceFragments.ts. */
export type RsglJsonResourceFragmentHandler =
  | "atlasDirectory"
  | "particlesSeq"
  | "mcmetaAnimation"
  | "nineSliceGui"
  | "equipmentLayers";

export interface RsglBuiltinCompletionDescriptor {
  label: string;
  insertText?: string;
  detail: string;
}

export interface RsglCollectionBuiltinDescriptorDefinition {
  name: string;
  effect: "pure";
  signature: RsglSignature;
  /**
   * Declared layer participation. "infer" requires an `infer` handler key,
   * "eval" requires an `eval` handler key; the contract test enforces both.
   */
  layers: readonly RsglCollectionBuiltinLayer[];
  infer?: RsglCollectionInferHandler;
  eval?: RsglCollectionEvalHandler;
  completion: RsglBuiltinCompletionDescriptor;
}

export type RsglJsonResourceFragmentKind = RsglGenericJsonResourceKind | "mcmeta";

export interface RsglJsonResourceFragmentDescriptorDefinition {
  kind: RsglJsonResourceFragmentKind;
  name: string;
  handler: RsglJsonResourceFragmentHandler;
  completion: RsglBuiltinCompletionDescriptor;
}

const t = typeParameter("T");
const u = typeParameter("U");
const r = typeParameter("R");

/**
 * Single registry for collection builtins. Semantic inference, runtime
 * evaluation, symbol signatures, and completion entries all derive from this
 * table; adding or renaming a collection builtin means editing this table plus
 * the referenced handler implementations.
 *
 * Declared exceptions:
 * - `has` is a pure scalar predicate (O(1) property check, no iteration, no
 *   budget consumption). It keeps specialized semantic inference only for
 *   better argument diagnostics, while the compiler inlines it in
 *   callEvaluation.ts alongside startsWith/replace/padStart, so it declares
 *   only the "infer" layer.
 * - `seq` is deliberately not in this table: its generator arguments bind
 *   scope identifiers (ForInExpr / named generators) that a value signature
 *   cannot express, so semantic/callChecking.ts, compiler/sequenceEvaluation.ts,
 *   and compiler/evaluationTrace.ts keep their by-name special cases.
 */
export const collectionBuiltinDescriptors = [
  {
    name: "asList",
    effect: "pure",
    signature: {
      parameters: [{ name: "value", type: asListSourceOf(t), optional: false }],
      returnType: listOfType(t),
      typeParameters: [genericParameter("T")]
    },
    layers: ["infer", "eval"],
    infer: "asList",
    eval: "asList",
    completion: {
      label: "asList",
      insertText: "asList(${1:value})",
      detail: "Keep a list, materialize a range, or wrap one scalar value"
    }
  },
  {
    name: "length",
    effect: "pure",
    signature: {
      parameters: [{ name: "source", type: iterableOf(t), optional: false }],
      returnType: numberType,
      typeParameters: [genericParameter("T")]
    },
    layers: ["infer", "eval"],
    infer: "length",
    eval: "length",
    completion: {
      label: "length",
      insertText: "length(${1:source})",
      detail: "Return the number of items in a List or Range"
    }
  },
  {
    name: "map",
    effect: "pure",
    signature: {
      parameters: [
        { name: "source", type: iterableOf(t), optional: false },
        { name: "mapper", type: functionOf([t], u), optional: false }
      ],
      returnType: listOfType(u),
      typeParameters: [genericParameter("T"), genericParameter("U")]
    },
    layers: ["infer", "eval"],
    infer: "map",
    eval: "map",
    completion: {
      label: "map",
      insertText: "map(${1:source}, ${2:item} => ${3:value})",
      detail: "Transform each collection item"
    }
  },
  {
    name: "filter",
    effect: "pure",
    signature: {
      parameters: [
        { name: "source", type: iterableOf(t), optional: false },
        { name: "predicate", type: functionOf([t], booleanType), optional: false }
      ],
      returnType: listOfType(t),
      typeParameters: [genericParameter("T")]
    },
    layers: ["infer", "eval"],
    infer: "filter",
    eval: "filter",
    completion: {
      label: "filter",
      insertText: "filter(${1:source}, ${2:item} => ${3:condition})",
      detail: "Keep collection items matching a Boolean predicate"
    }
  },
  {
    name: "flatMap",
    effect: "pure",
    signature: {
      parameters: [
        { name: "source", type: iterableOf(t), optional: false },
        { name: "mapper", type: functionOf([t], iterableOf(u)), optional: false }
      ],
      returnType: listOfType(u),
      typeParameters: [genericParameter("T"), genericParameter("U")]
    },
    layers: ["infer", "eval"],
    infer: "flatMap",
    eval: "flatMap",
    completion: {
      label: "flatMap",
      insertText: "flatMap(${1:source}, ${2:item} => ${3:items})",
      detail: "Transform and flatten collection items"
    }
  },
  {
    name: "flat",
    effect: "pure",
    signature: {
      parameters: [
        { name: "source", type: listOfType(t), optional: false },
        { name: "depth", type: numberType, optional: true }
      ],
      returnType: listOfType(t),
      typeParameters: [genericParameter("T")]
    },
    layers: ["infer", "eval"],
    infer: "flat",
    eval: "flat",
    completion: {
      label: "flat",
      insertText: "flat(${1:source})",
      detail: "Flatten nested Lists to an optional depth (all levels by default)"
    }
  },
  {
    name: "concat",
    effect: "pure",
    signature: {
      parameters: [
        { name: "sources", type: iterableOf(t), optional: false, rest: true }
      ],
      returnType: listOfType(t),
      typeParameters: [genericParameter("T")]
    },
    layers: ["infer", "eval"],
    infer: "concat",
    eval: "concat",
    completion: {
      label: "concat",
      insertText: "concat(${1:sources})",
      detail: "Concatenate compile-time collections"
    }
  },
  {
    name: "join",
    effect: "pure",
    signature: {
      parameters: [
        { name: "source", type: listOfType(stringType), optional: false },
        { name: "separator", type: stringType, optional: false }
      ],
      returnType: stringType
    },
    layers: ["infer", "eval"],
    infer: "join",
    eval: "join",
    completion: {
      label: "join",
      insertText: "join(${1:source}, ${2:separator})",
      detail: "Join a string list"
    }
  },
  {
    name: "entries",
    effect: "pure",
    signature: {
      parameters: [{ name: "object", type: r, optional: false }],
      returnType: listOfType(jsonType),
      typeParameters: [genericParameter("R", "record")]
    },
    layers: ["infer", "eval"],
    infer: "entries",
    eval: "entries",
    completion: {
      label: "entries",
      insertText: "entries(${1:object})",
      detail: "List an object's key/value entries"
    }
  },
  {
    name: "keys",
    effect: "pure",
    signature: {
      parameters: [{ name: "object", type: r, optional: false }],
      returnType: listOfType(stringType),
      typeParameters: [genericParameter("R", "record")]
    },
    layers: ["infer", "eval"],
    infer: "keys",
    eval: "keys",
    completion: {
      label: "keys",
      insertText: "keys(${1:object})",
      detail: "List an object's keys"
    }
  },
  {
    name: "values",
    effect: "pure",
    signature: {
      parameters: [{ name: "object", type: r, optional: false }],
      returnType: listOfType(jsonType),
      typeParameters: [genericParameter("R", "record")]
    },
    layers: ["infer", "eval"],
    infer: "values",
    eval: "values",
    completion: {
      label: "values",
      insertText: "values(${1:object})",
      detail: "List an object's values"
    }
  },
  {
    name: "mergeObjects",
    effect: "pure",
    signature: {
      parameters: [{ name: "objects", type: r, optional: false, rest: true }],
      returnType: r,
      typeParameters: [genericParameter("R", "record")]
    },
    layers: ["infer", "eval"],
    infer: "mergeObjects",
    eval: "mergeObjects",
    completion: {
      label: "mergeObjects",
      insertText: "mergeObjects(${1:objects})",
      detail: "Shallow-merge compile-time objects"
    }
  },
  {
    name: "product",
    effect: "pure",
    signature: {
      parameters: [{ name: "source", type: jsonType, optional: false }],
      returnType: listOfType(jsonType)
    },
    layers: ["infer", "eval"],
    infer: "product",
    eval: "product",
    completion: {
      label: "product",
      insertText: "product(${1:source})",
      detail: "Cartesian product of record dimensions into a list of rows"
    }
  },
  {
    name: "has",
    effect: "pure",
    signature: {
      parameters: [
        { name: "object", type: r, optional: false },
        { name: "key", type: stringType, optional: false }
      ],
      returnType: booleanType,
      typeParameters: [genericParameter("R", "record")]
    },
    // Scalar predicate: semantic inference is specialized only for argument
    // diagnostics; the compiler evaluates it inline in callEvaluation.ts.
    layers: ["infer"],
    infer: "has",
    completion: {
      label: "has",
      insertText: "has(${1:object}, ${2:key})",
      detail: "Test whether an object has a key"
    }
  }
] satisfies readonly RsglCollectionBuiltinDescriptorDefinition[];

export type RsglCollectionBuiltinDescriptor = (typeof collectionBuiltinDescriptors)[number];

/** Sugar builtins dispatched by (resource kind, callee name) in jsonResourceFragments. */
export const jsonResourceFragmentBuiltinDescriptors = [
  {
    kind: "atlas",
    name: "atlasDirectory",
    handler: "atlasDirectory",
    completion: {
      label: "atlasDirectory",
      detail: "Atlas directory source helper"
    }
  },
  {
    kind: "particles",
    name: "particlesSeq",
    handler: "particlesSeq",
    completion: {
      label: "particlesSeq",
      insertText: "particlesSeq(\"${1:minecraft:particle/explosion_{0..2}}\", pad: ${2:0})",
      detail: "Particle texture sequence helper"
    }
  },
  {
    kind: "mcmeta",
    name: "mcmetaAnimation",
    handler: "mcmetaAnimation",
    completion: {
      label: "mcmetaAnimation",
      detail: "PNG animation metadata helper"
    }
  },
  {
    kind: "mcmeta",
    name: "nineSliceGui",
    handler: "nineSliceGui",
    completion: {
      label: "nineSliceGui",
      detail: "PNG GUI nine-slice metadata helper"
    }
  },
  {
    kind: "equipment",
    name: "equipmentLayers",
    handler: "equipmentLayers",
    completion: {
      label: "equipmentLayers",
      detail: "Equipment layer helper"
    }
  }
] satisfies readonly RsglJsonResourceFragmentDescriptorDefinition[];

const collectionDescriptorByName: ReadonlyMap<string, RsglCollectionBuiltinDescriptor> = new Map(
  collectionBuiltinDescriptors.map(descriptor => [descriptor.name, descriptor])
);

export function getCollectionBuiltinDescriptor(name: string): RsglCollectionBuiltinDescriptor | undefined {
  return collectionDescriptorByName.get(name);
}

/** Names of collection builtins participating in the given layer, in registry order. */
export function collectionBuiltinNamesForLayer(layer: RsglCollectionBuiltinLayer): readonly string[] {
  return collectionBuiltinDescriptors
    .filter(descriptor => (descriptor.layers as readonly RsglCollectionBuiltinLayer[]).includes(layer))
    .map(descriptor => descriptor.name);
}

export function getJsonResourceFragmentBuiltinDescriptor(
  kind: string,
  name: string
): (typeof jsonResourceFragmentBuiltinDescriptors)[number] | undefined {
  return jsonResourceFragmentBuiltinDescriptors.find(descriptor =>
    descriptor.kind === kind && descriptor.name === name);
}

function listOfType(elementType: RsglType): RsglType {
  return { kind: "List", elementType };
}

function iterableOf(elementType: RsglType): RsglType {
  return {
    kind: "Union",
    options: [listOfType(elementType), { kind: "Range", elementType: numberType }]
  };
}

function asListSourceOf(elementType: RsglType): RsglType {
  return {
    kind: "Union",
    options: [elementType, listOfType(elementType), { kind: "Range", elementType: numberType }]
  };
}

function functionOf(parameters: RsglType[], returnType: RsglType): RsglType {
  return { kind: "Function", parameters, returnType };
}

function typeParameter(name: string): RsglType {
  return { kind: "TypeParameter", typeParameterName: name };
}

function genericParameter(
  name: string,
  constraint: RsglGenericParameter["constraint"] = "value"
): RsglGenericParameter {
  return { name, constraint };
}
