import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleEntryDefinitions, bundleTargetProfiles } from "./build-bundles.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultBudgetFile = path.join(scriptDirectory, "build-budgets.json");

export const mainVsixBudgetEntryIds = bundleTargetProfiles.main;

export function readBuildBudgetConfiguration(fileName = defaultBudgetFile) {
  let value;
  try {
    value = JSON.parse(readFileSync(fileName, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read build budget configuration: ${fileName}`, { cause: error });
  }
  return parseBuildBudgetConfiguration(value);
}

export function parseBuildBudgetConfiguration(value) {
  if (!isPlainObject(value)) {
    throw new Error("Build budget configuration must be an object.");
  }
  if (value.schemaVersion !== 2) {
    throw new Error("Build budget configuration schemaVersion must be 2.");
  }
  assertPositiveBudget(value.activationModules?.root, "activationModules.root");
  assertPositiveBudget(value.activationModules?.rsglHost, "activationModules.rsglHost");
  assertPositiveBudget(value.coldActivationMilliseconds?.root, "coldActivationMilliseconds.root");
  assertPositiveBudget(
    value.coldActivationMilliseconds?.rsglHost,
    "coldActivationMilliseconds.rsglHost"
  );
  assertNonNegativeInteger(
    value.coldActivationSampling?.discardedWarmupProcesses,
    "coldActivationSampling.discardedWarmupProcesses"
  );
  assertPositiveBudget(
    value.coldActivationSampling?.measuredProcesses,
    "coldActivationSampling.measuredProcesses"
  );
  assertPositiveBudget(
    value.coldActivationSampling?.processTimeoutMilliseconds,
    "coldActivationSampling.processTimeoutMilliseconds"
  );
  assertPositiveBudget(
    value.jsonOnlyExtensionHost?.minimumIterations,
    "jsonOnlyExtensionHost.minimumIterations"
  );
  assertPositiveBudget(
    value.jsonOnlyExtensionHost?.minimumSteadyStateSettleMilliseconds,
    "jsonOnlyExtensionHost.minimumSteadyStateSettleMilliseconds"
  );
  assertPositiveBudget(
    value.jsonOnlyExtensionHost?.maximumAbsoluteP95RegressionMilliseconds,
    "jsonOnlyExtensionHost.maximumAbsoluteP95RegressionMilliseconds"
  );
  assertRatioBudget(
    value.jsonOnlyExtensionHost?.maximumRelativeP95RegressionRatio,
    "jsonOnlyExtensionHost.maximumRelativeP95RegressionRatio"
  );
  assertPositiveBudget(
    value.jsonOnlyExtensionHost?.maximumSteadyRssP95DeltaBytes,
    "jsonOnlyExtensionHost.maximumSteadyRssP95DeltaBytes"
  );
  assertRuntimeBenchmarkBudgets(value.runtimeBenchmarks);
  for (const entryId of Object.keys(bundleEntryDefinitions)) {
    assertPositiveBudget(
      value.bundleBytes?.production?.[entryId],
      `bundleBytes.production.${entryId}`
    );
  }
  for (const entryId of Object.keys(bundleEntryDefinitions)) {
    assertPositiveBudget(
      value.bundleGzipBytes?.production?.[entryId],
      `bundleGzipBytes.production.${entryId}`
    );
  }
  if (!isPlainObject(value.mainVsix)) {
    throw new Error("Missing mainVsix artifact budget configuration.");
  }
  for (const metric of [
    "archiveBytes",
    "compressedEntriesBytes",
    "installedBytes",
    "fileCount"
  ]) {
    assertPendingOrPositiveBudget(value.mainVsix[metric], `mainVsix.${metric}`);
  }
  if (!isPlainObject(value.mainVsix.runtimeEntryCompressedBytes)) {
    throw new Error("Missing mainVsix.runtimeEntryCompressedBytes budget configuration.");
  }
  const configuredEntries = Object.keys(value.mainVsix.runtimeEntryCompressedBytes).sort();
  const expectedEntries = [...mainVsixBudgetEntryIds].sort();
  if (JSON.stringify(configuredEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error(
      `mainVsix.runtimeEntryCompressedBytes must define ${expectedEntries.join(", ")}.`
    );
  }
  for (const entryId of mainVsixBudgetEntryIds) {
    assertPendingOrPositiveBudget(
      value.mainVsix.runtimeEntryCompressedBytes[entryId],
      `mainVsix.runtimeEntryCompressedBytes.${entryId}`
    );
  }
  return Object.freeze(value);
}

function assertRuntimeBenchmarkBudgets(value) {
  if (!isPlainObject(value)) {
    throw new Error("Missing runtimeBenchmarks budget configuration.");
  }
  const groups = [
    ["modelPreviewMilliseconds", value.modelPreviewMilliseconds, 2],
    ["rsglSmokeP95Milliseconds", value.rsglSmokeP95Milliseconds, 1],
    ["resourceUniverseSmokeP95Milliseconds", value.resourceUniverseSmokeP95Milliseconds, 2]
  ];
  for (const [label, group, minimumDepth] of groups) {
    if (!isPlainObject(group) || Object.keys(group).length === 0) {
      throw new Error(`runtimeBenchmarks.${label} must be a non-empty budget map.`);
    }
    assertPositiveBudgetTree(group, `runtimeBenchmarks.${label}`, minimumDepth);
  }
}

function assertPositiveBudgetTree(value, label, remainingDepth) {
  if (remainingDepth === 0) {
    assertPositiveBudget(value, label);
    return;
  }
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw new Error(`${label} must be a non-empty budget map.`);
  }
  for (const [name, child] of Object.entries(value)) {
    assertPositiveBudgetTree(child, `${label}.${name}`, remainingDepth - 1);
  }
}

function assertPositiveBudget(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer budget.`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function assertPendingOrPositiveBudget(value, label) {
  if (value !== null) {
    assertPositiveBudget(value, label);
  }
}

function assertRatioBudget(value, label) {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${label} must be a finite ratio greater than 0 and less than 1.`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
