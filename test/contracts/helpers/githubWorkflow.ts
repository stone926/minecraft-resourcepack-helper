import * as fs from "node:fs";
import * as path from "node:path";
import { load } from "js-yaml";

export type WorkflowPermissionValue = "read" | "write" | "none";
export type WorkflowPermissions =
  | "read-all"
  | "write-all"
  | Record<string, WorkflowPermissionValue>;

export interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}

export interface WorkflowJob {
  name?: string;
  if?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: "inherit" | Record<string, unknown>;
  "runs-on"?: string | string[];
  "timeout-minutes"?: number;
  environment?: string | { name: string; url?: string };
  permissions?: WorkflowPermissions;
  strategy?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  steps?: WorkflowStep[];
}

export interface WorkflowTriggerConfig {
  branches?: string[];
  tags?: string[];
  inputs?: Record<string, unknown>;
  [key: string]: unknown;
}

export type WorkflowTriggerValue = WorkflowTriggerConfig | WorkflowTriggerConfig[] | null;

export type WorkflowTriggers =
  | string
  | string[]
  | Record<string, WorkflowTriggerValue>;

export interface WorkflowConcurrency {
  group?: string;
  "cancel-in-progress"?: boolean | string;
}

export interface GitHubWorkflow {
  name?: string;
  on?: WorkflowTriggers;
  permissions?: WorkflowPermissions;
  concurrency?: string | WorkflowConcurrency;
  jobs: Record<string, WorkflowJob>;
}

export interface WorkflowUse {
  fileName: string;
  jobId: string;
  stepName?: string;
  uses: string;
  kind: "job" | "step";
}

export interface WorkflowRunStep {
  fileName: string;
  jobId: string;
  stepName?: string;
  run: string;
  step: WorkflowStep;
}

export interface LoadedWorkflow {
  fileName: string;
  workflow: GitHubWorkflow;
}

/** Loads one GitHub Actions workflow and validates the object/array seams used by contract tests. */
export function loadGitHubWorkflow(fileName: string): GitHubWorkflow {
  const raw = load(fs.readFileSync(fileName, "utf8"), { filename: fileName });
  const root = requireRecord(raw, `${fileName}: workflow root`);
  const jobs = requireRecord(root.jobs, `${fileName}: jobs`);

  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = requireRecord(rawJob, `${fileName}: jobs.${jobId}`);
    requireOptionalString(job.name, `${fileName}: jobs.${jobId}.name`);
    requireOptionalString(job.if, `${fileName}: jobs.${jobId}.if`);
    requireOptionalString(job.uses, `${fileName}: jobs.${jobId}.uses`);
    if (
      job["timeout-minutes"] !== undefined
      && (typeof job["timeout-minutes"] !== "number" || !Number.isFinite(job["timeout-minutes"]))
    ) {
      throw new Error(`${fileName}: jobs.${jobId}.timeout-minutes must be a finite number`);
    }
    if (job.with !== undefined) {
      requireRecord(job.with, `${fileName}: jobs.${jobId}.with`);
    }
    if (job.permissions !== undefined) {
      requireWorkflowPermissions(job.permissions, `${fileName}: jobs.${jobId}.permissions`);
    }
    if (job.steps !== undefined) {
      if (!Array.isArray(job.steps)) {
        throw new Error(`${fileName}: jobs.${jobId}.steps must be an array`);
      }
      job.steps.forEach((step, index) => {
        const stepLabel = `${fileName}: jobs.${jobId}.steps[${index}]`;
        const stepRecord = requireRecord(step, stepLabel);
        for (const field of ["name", "id", "if", "uses", "run", "shell"] as const) {
          requireOptionalString(stepRecord[field], `${stepLabel}.${field}`);
        }
        if (stepRecord.env !== undefined) {
          requireRecord(stepRecord.env, `${stepLabel}.env`);
        }
        if (stepRecord.with !== undefined) {
          requireRecord(stepRecord.with, `${stepLabel}.with`);
        }
      });
    }
  }

  if (root.permissions !== undefined) {
    requireWorkflowPermissions(root.permissions, `${fileName}: permissions`);
  }

  return root as unknown as GitHubWorkflow;
}

export function loadGitHubWorkflows(directory: string): LoadedWorkflow[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map(entry => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right, "en"))
    .map(fileName => ({ fileName, workflow: loadGitHubWorkflow(fileName) }));
}

export function getWorkflowJob(workflow: GitHubWorkflow, jobId: string): WorkflowJob {
  const job = workflow.jobs[jobId];
  if (!job) {
    throw new Error(`Missing workflow job: ${jobId}`);
  }
  return job;
}

export function getWorkflowStep(
  workflow: GitHubWorkflow,
  jobId: string,
  stepName: string
): WorkflowStep {
  const matches = (getWorkflowJob(workflow, jobId).steps ?? [])
    .filter(step => step.name === stepName);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${jobId} step named ${JSON.stringify(stepName)}, found ${matches.length}`
    );
  }
  return matches[0];
}

export function getWorkflowTrigger(
  workflow: GitHubWorkflow,
  triggerName: string
): WorkflowTriggerConfig | null | undefined {
  if (!workflow.on || typeof workflow.on === "string" || Array.isArray(workflow.on)) {
    return undefined;
  }
  const trigger = workflow.on[triggerName];
  if (Array.isArray(trigger)) {
    throw new Error(`Workflow trigger ${triggerName} is a list, not a configuration object`);
  }
  return trigger;
}

export function workflowUses(loaded: LoadedWorkflow): WorkflowUse[] {
  const uses: WorkflowUse[] = [];
  for (const [jobId, job] of Object.entries(loaded.workflow.jobs)) {
    if (job.uses) {
      uses.push({
        fileName: loaded.fileName,
        jobId,
        uses: job.uses,
        kind: "job"
      });
    }
    for (const step of job.steps ?? []) {
      if (step.uses) {
        uses.push({
          fileName: loaded.fileName,
          jobId,
          stepName: step.name,
          uses: step.uses,
          kind: "step"
        });
      }
    }
  }
  return uses;
}

export function workflowRunSteps(loaded: LoadedWorkflow): WorkflowRunStep[] {
  return Object.entries(loaded.workflow.jobs).flatMap(([jobId, job]) =>
    (job.steps ?? []).flatMap(step => step.run === undefined ? [] : [{
      fileName: loaded.fileName,
      jobId,
      stepName: step.name,
      run: step.run,
      step
    }])
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
}

function requireWorkflowPermissions(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (value !== "read-all" && value !== "write-all") {
      throw new Error(`${label} must be read-all, write-all, or a permission map`);
    }
    return;
  }
  const permissions = requireRecord(value, label);
  for (const [name, permission] of Object.entries(permissions)) {
    if (permission !== "read" && permission !== "write" && permission !== "none") {
      throw new Error(`${label}.${name} must be read, write, or none`);
    }
  }
}
