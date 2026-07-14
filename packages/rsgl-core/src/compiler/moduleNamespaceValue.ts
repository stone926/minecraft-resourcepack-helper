import type {
  EvaluationOrigin,
  EvaluationPathOrigin,
  EvaluationValue,
  EvaluationValueIssue
} from "./evaluate";
import type { RsglTemplateDefinition } from "./environment";

export interface ModuleNamespaceValueOptions {
  fileName: string;
  namespace: string;
  values: ReadonlyMap<string, EvaluationValue>;
  valueOrigins: ReadonlyMap<string, EvaluationOrigin>;
  valuePathOrigins: ReadonlyMap<string, readonly EvaluationPathOrigin[]>;
  valueIssues: ReadonlyMap<string, readonly EvaluationValueIssue[]>;
  templates: ReadonlyMap<string, RsglTemplateDefinition>;
}

export interface ModuleNamespaceValueMember {
  value: EvaluationValue;
  origin?: EvaluationOrigin;
  pathOrigins: readonly EvaluationPathOrigin[];
  valueIssues: readonly EvaluationValueIssue[];
}

/**
 * Compiler-only value representing one imported module's public namespace.
 *
 * The maps are intentionally retained by reference. Module environments are
 * linked recursively, so a namespace created while resolving an import cycle
 * must observe exports populated later instead of snapshotting an empty map.
 * A class instance also keeps the namespace outside the plain-object JSON
 * domain, even when an imported module happens to export fields named `kind`,
 * `values`, or `templates`.
 */
export class ModuleNamespaceValue {
  public readonly kind = "moduleNamespace" as const;
  public readonly fileName: string;
  public readonly namespace: string;
  public readonly values: ReadonlyMap<string, EvaluationValue>;
  public readonly valueOrigins: ReadonlyMap<string, EvaluationOrigin>;
  public readonly valuePathOrigins: ReadonlyMap<string, readonly EvaluationPathOrigin[]>;
  public readonly valueIssues: ReadonlyMap<string, readonly EvaluationValueIssue[]>;
  public readonly templates: ReadonlyMap<string, RsglTemplateDefinition>;

  public constructor(options: ModuleNamespaceValueOptions) {
    this.fileName = options.fileName;
    this.namespace = options.namespace;
    this.values = options.values;
    this.valueOrigins = options.valueOrigins;
    this.valuePathOrigins = options.valuePathOrigins;
    this.valueIssues = options.valueIssues;
    this.templates = options.templates;
    Object.freeze(this);
  }

  public resolveValue(name: string): ModuleNamespaceValueMember | undefined {
    if (!this.values.has(name)) {
      return undefined;
    }
    const origin = this.valueOrigins.get(name);
    return {
      value: this.values.get(name),
      ...(origin ? { origin } : {}),
      pathOrigins: this.valuePathOrigins.get(name) ?? [],
      valueIssues: this.valueIssues.get(name) ?? []
    };
  }

  public resolveTemplate(name: string): RsglTemplateDefinition | undefined {
    return this.templates.get(name);
  }
}

export function isModuleNamespaceValue(value: unknown): value is ModuleNamespaceValue {
  return value instanceof ModuleNamespaceValue;
}
