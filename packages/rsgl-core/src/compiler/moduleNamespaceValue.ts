import type {
  EvaluationOrigin,
  EvaluationPathOrigin,
  EvaluationValue,
  EvaluationValueIssue
} from "./evaluationTypes";
import type { RsglTemplateDefinition, ValueBinding } from "./environment";

export interface ModuleNamespaceValueOptions {
  fileName: string;
  namespace: string;
  valueBindings: ReadonlyMap<string, ValueBinding>;
  templates: ReadonlyMap<string, RsglTemplateDefinition>;
}

export interface ModuleNamespaceValueMember {
  value: EvaluationValue;
  origin?: EvaluationOrigin;
  pathOrigins: readonly EvaluationPathOrigin[];
  selectionPathOrigins: readonly EvaluationPathOrigin[];
  valueIssues: readonly EvaluationValueIssue[];
}

/**
 * Compiler-only value representing one imported module's public namespace.
 *
 * The binding and template maps are intentionally retained by reference.
 * Module environments are linked recursively, so a namespace created while
 * resolving an import cycle must observe exports populated later instead of
 * snapshotting an empty map.
 * A class instance also keeps the namespace outside the plain-object JSON
 * domain, even when an imported module happens to export fields named `kind`,
 * `values`, or `templates`.
 */
export class ModuleNamespaceValue {
  public readonly kind = "moduleNamespace" as const;
  public readonly fileName: string;
  public readonly namespace: string;
  public readonly valueBindings: ReadonlyMap<string, ValueBinding>;
  public readonly templates: ReadonlyMap<string, RsglTemplateDefinition>;

  public constructor(options: ModuleNamespaceValueOptions) {
    this.fileName = options.fileName;
    this.namespace = options.namespace;
    this.valueBindings = options.valueBindings;
    this.templates = options.templates;
    Object.freeze(this);
  }

  public resolveValue(name: string): ModuleNamespaceValueMember | undefined {
    const binding = this.valueBindings.get(name);
    if (!binding) {
      return undefined;
    }
    return {
      value: binding.value,
      ...(binding.origin ? { origin: binding.origin } : {}),
      pathOrigins: binding.pathOrigins ?? [],
      selectionPathOrigins: binding.selectionPathOrigins ?? [],
      valueIssues: binding.valueIssues ?? []
    };
  }

  public resolveTemplate(name: string): RsglTemplateDefinition | undefined {
    return this.templates.get(name);
  }
}

export function isModuleNamespaceValue(value: unknown): value is ModuleNamespaceValue {
  return value instanceof ModuleNamespaceValue;
}
