import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadGitHubWorkflows,
  workflowRunSteps,
  workflowUses
} from "./helpers/githubWorkflow";

describe("GitHub workflow structure", () => {
  const root = process.cwd();
  const workflowDirectory = path.join(root, ".github", "workflows");

  it("parses every committed workflow as a typed jobs document", () => {
    const workflows = loadGitHubWorkflows(workflowDirectory);

    assert.ok(workflows.length > 0, `No workflows found in ${workflowDirectory}`);
    for (const { fileName, workflow } of workflows) {
      assert.ok(Object.keys(workflow.jobs).length > 0, `${relative(fileName)} must declare jobs`);
    }
  });

  it("pins every external action to a full 40-character commit SHA", () => {
    const externalUses = loadGitHubWorkflows(workflowDirectory)
      .flatMap(workflowUses)
      .filter(use => !use.uses.startsWith("./"));

    assert.ok(externalUses.length > 0, "Expected at least one external workflow action");
    for (const use of externalUses) {
      const location = [relative(use.fileName), use.jobId, use.stepName]
        .filter((value): value is string => !!value)
        .join(" / ");
      assert.match(use.uses, /^[^@\s]+@[0-9a-f]{40}$/, `${location}: ${use.uses}`);
    }
  });

  it("references only npm scripts declared by the root manifest", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = manifest.scripts ?? {};
    const references = loadGitHubWorkflows(workflowDirectory).flatMap(workflow =>
      workflowRunSteps(workflow).flatMap(step => [...step.run.matchAll(
        /\bnpm\s+run\s+([a-zA-Z0-9][a-zA-Z0-9:_-]*)/g
      )].map(match => ({ ...step, script: match[1] })))
    );

    assert.ok(references.length > 0, "Expected workflows to invoke root npm scripts");
    for (const reference of references) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(scripts, reference.script),
        `${relative(reference.fileName)} / ${reference.jobId} / ${reference.stepName ?? "unnamed"}`
          + ` references missing npm script ${reference.script}`
      );
    }
  });

  function relative(fileName: string): string {
    return path.relative(root, fileName).replaceAll("\\", "/");
  }
});
