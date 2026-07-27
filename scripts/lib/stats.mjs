/** Shared numeric summary helpers for benchmark and measurement scripts. */

/**
 * Nearest-rank percentile over an ascending pre-sorted numeric array.
 * Callers sort once and may take several percentiles from the same array.
 */
export function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** Sum of a selected numeric field across samples. */
export function sum(samples, selector) {
  return samples.reduce((total, sample) => total + selector(sample), 0);
}
