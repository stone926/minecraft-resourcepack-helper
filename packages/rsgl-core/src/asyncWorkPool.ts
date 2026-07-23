/**
 * Applies an asynchronous operation with bounded concurrency while preserving
 * the input order in the returned results.
 *
 * Once an operation rejects, workers stop taking new values. Operations that
 * are already in flight are allowed to settle before a failure is rethrown,
 * so callers do not observe background work after this promise
 * settles. If multiple in-flight operations fail, the failure from the lowest
 * input index is reported so diagnostics do not depend on I/O completion order.
 */
export async function mapWithConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer.");
  }
  if (values.length === 0) {
    return [];
  }

  const results = new Array<TResult>(values.length);
  let nextIndex = 0;
  let failure: { readonly index: number; readonly error: unknown } | undefined;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = nextIndex;
      if (index >= values.length) {
        return;
      }
      nextIndex++;
      try {
        results[index] = await operation(values[index], index);
      } catch (error) {
        if (!failure || index < failure.index) {
          failure = { index, error };
        }
        failed = true;
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker()
  );
  await Promise.all(workers);
  if (failure) {
    throw failure.error;
  }
  return results;
}
