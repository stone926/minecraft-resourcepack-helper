import * as vscode from "vscode";

/** Tracks command transactions so runtime shutdown can cancel and await active workers. */
export class RsglCommandLifecycle {
  private readonly active = new Map<vscode.CancellationTokenSource, Promise<unknown>>();
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  public execute<T>(operation: (token: vscode.CancellationToken) => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("The RSGL build runtime has been disposed."));
    }

    const cancellation = new vscode.CancellationTokenSource();
    const promise = Promise.resolve()
      .then(() => operation(cancellation.token))
      .finally(() => {
        this.active.delete(cancellation);
        cancellation.dispose();
      });
    this.active.set(cancellation, promise);
    return promise;
  }

  public dispose(): Promise<void> {
    return this.disposePromise ??= (async () => {
      this.disposed = true;
      const pending = [...this.active.entries()];
      for (const [cancellation] of pending) {
        cancellation.cancel();
      }
      await Promise.allSettled(pending.map(([, operation]) => operation));
    })();
  }
}

/** Combines the progress UI token with the owning runtime transaction token. */
export async function withCombinedCancellation<T>(
  first: vscode.CancellationToken,
  second: vscode.CancellationToken,
  operation: (token: vscode.CancellationToken) => Promise<T>
): Promise<T> {
  const cancellation = new vscode.CancellationTokenSource();
  const subscriptions = [
    first.onCancellationRequested(() => cancellation.cancel()),
    second.onCancellationRequested(() => cancellation.cancel())
  ];
  if (first.isCancellationRequested || second.isCancellationRequested) {
    cancellation.cancel();
  }

  try {
    return await operation(cancellation.token);
  } finally {
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
    cancellation.dispose();
  }
}
