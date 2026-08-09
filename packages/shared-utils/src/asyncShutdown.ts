import type { Disposable } from "./disposable";

export interface AsyncShutdown {
  shutdown(): Promise<void>;
}

export interface AsyncShutdownDisposable extends AsyncShutdown, Disposable {}

export type AsyncShutdownErrorHandler = (error: unknown) => void;

/** Adapts one single-flight asynchronous teardown to a synchronous disposable. */
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
