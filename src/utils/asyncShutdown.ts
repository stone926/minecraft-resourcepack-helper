import type * as vscode from "vscode";

export interface AsyncShutdown {
  shutdown(): Promise<void>;
}

export interface AsyncShutdownDisposable extends AsyncShutdown, vscode.Disposable {}

export type AsyncShutdownErrorHandler = (error: unknown) => void;

/**
 * Exposes one single-flight asynchronous teardown through both an awaited
 * shutdown boundary and VS Code's synchronous Disposable contract.
 */
export function asDisposable(
  shutdown: () => Promise<void>,
  onError: AsyncShutdownErrorHandler = error => console.error(error)
): AsyncShutdownDisposable {
  let shutdownPromise: Promise<void> | undefined;
  let disposalObserved = false;
  let awaitedShutdownRequested = false;
  const shutdownOnce = (): Promise<void> => {
    if (!shutdownPromise) {
      try {
        shutdownPromise = shutdown();
      } catch (error) {
        shutdownPromise = Promise.reject(error);
      }
    }
    return shutdownPromise;
  };
  return {
    shutdown: () => {
      awaitedShutdownRequested = true;
      return shutdownOnce();
    },
    dispose: () => {
      if (disposalObserved) {
        return;
      }
      disposalObserved = true;
      if (awaitedShutdownRequested) {
        return;
      }
      void shutdownOnce().catch(error => {
        if (!awaitedShutdownRequested) {
          onError(error);
        }
      });
    }
  };
}
