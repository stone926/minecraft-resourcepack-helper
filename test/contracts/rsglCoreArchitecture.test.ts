import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("RSGL core architecture", () => {
  const root = process.cwd();
  const sourceRoot = path.join(root, "packages", "rsgl-core", "src");

  it("keeps compiler, evaluator, and expression-checker facades below the god-file budget", () => {
    assertLineBudget(path.join(sourceRoot, "compiler", "compiler.ts"), 650);
    assertLineBudget(path.join(sourceRoot, "compiler", "evaluate.ts"), 700);
    assertLineBudget(path.join(sourceRoot, "semantic", "expressionChecker.ts"), 650);
  });

  it("keeps extracted modules independent from their orchestration facades", () => {
    assertNoFacadeImport("compiler/compiler.ts", [
      "compiler/compilerOutputAccumulator.ts",
      "compiler/resourceBodyLowering.ts"
    ]);
    assertNoFacadeImport("compiler/evaluate.ts", [
      "compiler/callEvaluation.ts",
      "compiler/collectionExpressionEvaluation.ts",
      "compiler/evaluationBindings.ts",
      "compiler/evaluationBudget.ts",
      "compiler/evaluationErrors.ts",
      "compiler/evaluationJsonValues.ts",
      "compiler/evaluationProvenance.ts",
      "compiler/evaluationRuntimeHost.ts",
      "compiler/evaluationTrace.ts",
      "compiler/evaluationTypes.ts",
      "compiler/lambdaEvaluation.ts",
      "compiler/sequenceEvaluation.ts"
    ]);
    assertNoFacadeImport("semantic/expressionChecker.ts", [
      "semantic/contextualExpressionChecking.ts",
      "semantic/expressionTypeCompatibility.ts",
      "semantic/resourceExpressionSyntax.ts",
      "semantic/structuralExpressionChecking.ts"
    ]);
  });

  it("has no runtime strongly connected components in compiled rsgl-core modules", () => {
    const compiledRoot = path.join(root, "out", "packages", "rsgl-core", "src");
    const files = listFiles(compiledRoot, fileName => fileName.endsWith(".js"));
    const fileSet = new Set(files.map(fileName => path.normalize(fileName)));
    const graph = new Map<string, string[]>();

    for (const fileName of fileSet) {
      const dependencies = new Set<string>();
      const source = fs.readFileSync(fileName, "utf8");
      for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
        if (!match[1].startsWith(".")) {
          continue;
        }
        const dependency = resolveCompiledModule(fileName, match[1]);
        if (dependency && fileSet.has(dependency)) {
          dependencies.add(dependency);
        }
      }
      graph.set(fileName, [...dependencies]);
    }

    const cycles = stronglyConnectedComponents(graph)
      .filter(component => component.length > 1 || graph.get(component[0])?.includes(component[0]))
      .map(component => component
        .map(fileName => relativePath(compiledRoot, fileName))
        .sort());
    assert.deepStrictEqual(cycles, []);
  });

  function assertNoFacadeImport(facade: string, modules: readonly string[]): void {
    const facadeName = path.basename(facade, ".ts");
    const importPattern = new RegExp(`["']\\./${escapeRegExp(facadeName)}(?:\\.js)?["']`);
    for (const modulePath of modules) {
      const source = fs.readFileSync(path.join(sourceRoot, modulePath), "utf8");
      assert.strictEqual(
        importPattern.test(source),
        false,
        `${modulePath} must not import its ${facadeName} facade`
      );
    }
  }
});

function assertLineBudget(fileName: string, maximum: number): void {
  const lines = fs.readFileSync(fileName, "utf8").trimEnd().split(/\r?\n/).length;
  assert.ok(lines <= maximum, `${relativePath(process.cwd(), fileName)} has ${lines} lines; maximum is ${maximum}`);
}

function listFiles(directory: string, include: (fileName: string) => boolean): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fileName = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fileName, include));
    } else if (entry.isFile() && include(fileName)) {
      files.push(path.normalize(fileName));
    }
  }
  return files;
}

function resolveCompiledModule(fromFile: string, specifier: string): string | undefined {
  const candidate = path.resolve(path.dirname(fromFile), specifier);
  for (const fileName of [`${candidate}.js`, path.join(candidate, "index.js")]) {
    if (fs.existsSync(fileName)) {
      return path.normalize(fileName);
    }
  }
  return undefined;
}

function stronglyConnectedComponents(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string): void => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(dependency)!));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) {
      return;
    }
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component);
  };

  for (const node of graph.keys()) {
    if (!indices.has(node)) {
      visit(node);
    }
  }
  return components;
}

function relativePath(root: string, fileName: string): string {
  return path.relative(root, fileName).replaceAll(path.sep, "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
