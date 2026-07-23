/**
 * Main-bundle bounded work pool. This stays outside rsgl-core so the root
 * extension bundle does not make the compiler statically reachable.
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

  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker()
  ));
  if (failure) {
    throw failure.error;
  }
  return results;
}
