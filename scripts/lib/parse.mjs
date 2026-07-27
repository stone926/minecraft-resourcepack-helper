/** Shared argument/value validation helpers for build and measurement scripts. */

export function parseInteger(value, label, minimum, maximum, multiple = 1) {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)
    || parsed < minimum || parsed > maximum || parsed % multiple !== 0) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}${multiple > 1 ? ` divisible by ${multiple}` : ""}.`);
  }
  return parsed;
}

export function parseSha256(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

export function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

export function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Total-order text comparison without locale rules, for stable file lists. */
export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** True when every element is a string and the list is strictly ascending. */
export function isSortedUnique(values) {
  return values.every((value, index) => typeof value === "string"
    && (index === 0 || values[index - 1] < value));
}

/** Parses UTF-8 JSON bytes, tolerating a leading byte-order mark. */
export function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8").replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}.`, { cause: error });
  }
}

/**
 * Shell-transcript display form of one argv value: safe characters pass
 * through, anything else is shown as a JSON string literal.
 */
export function shellDisplayArgument(argument) {
  return /^[A-Za-z0-9_./:@=+\\-]+$/.test(argument)
    ? argument
    : JSON.stringify(argument);
}
