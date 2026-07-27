import { execFileSync } from "node:child_process";
import path from "node:path";

/** Shared plan-step model for orchestration scripts that run child Node
 * scripts from the repository root. */

export function nodeStep(label, script, args = []) {
  return Object.freeze({ label, script, args: Object.freeze(args) });
}

export function formatStepCommand(step) {
  return `> node ${step.script}${step.args.length > 0 ? ` ${step.args.join(" ")}` : ""}`;
}

export function defaultExecuteStep(step, context) {
  execFileSync(
    process.execPath,
    [path.resolve(context.repositoryRoot, step.script), ...step.args],
    { cwd: context.repositoryRoot, stdio: "inherit", env: context.env }
  );
}

/** Runs each step in order, logging its command line, stopping on failure. */
export function executeNodeSteps(plan, options) {
  const executeStep = options.executeStep ?? defaultExecuteStep;
  const logger = options.logger ?? console;
  for (const step of plan) {
    logger.log(formatStepCommand(step));
    executeStep(step, { repositoryRoot: options.repositoryRoot });
  }
}
