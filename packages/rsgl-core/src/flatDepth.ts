/**
 * Normalizes a valid Number depth with the same ToIntegerOrInfinity behavior
 * used by Array.prototype.flat, then clamps negative depths to zero.
 */
export function normalizeFlatDepth(value: number): number {
  if (Number.isNaN(value) || value <= 0) {
    return 0;
  }
  return value === Number.POSITIVE_INFINITY ? value : Math.trunc(value);
}
