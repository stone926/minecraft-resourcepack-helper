import type { RsglModule, TemplateDeclNode } from "../parser";
import { walkRsglModule } from "../parser/astTraversal";

/**
 * Answers legacy StateKeySugar key lookup using the evaluator's exact alias
 * contract. Legacy keys are dynamic by parameter name throughout that
 * template body; ordinary lets, loops, imports, tables, and namespaces never
 * opt a key into dynamic evaluation.
 */
export class MigrationSymbolResolution {
  private readonly templates: readonly TemplateDeclNode[];

  public constructor(module: RsglModule) {
    this.templates = collectTemplates(module);
  }

  public resolvesValue(name: string, offset: number): boolean {
    return this.templates.some(template =>
      template.body.range.start <= offset
      && offset <= template.body.range.end
      && template.parameters.some(parameter => parameter.name?.text === name)
    );
  }
}

function collectTemplates(module: RsglModule): TemplateDeclNode[] {
  const templates: TemplateDeclNode[] = [];
  walkRsglModule(module, {
    enterStatement(statement) {
      if (statement.kind === "TemplateDecl") {
        templates.push(statement);
      }
    }
  });
  return templates;
}
