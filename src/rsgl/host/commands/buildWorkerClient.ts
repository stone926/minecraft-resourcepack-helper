import { Worker } from "node:worker_threads";
import type {
  RsglAnyWorkerRequest,
  RsglWorkerOutcome,
  RsglWorkerRequest,
  RsglWorkerRequestEnvelope,
  RsglWorkerResponse,
  RsglWorkerTaskKind
} from "./buildWorkerProtocol";
import { RsglBuildWorkerExitError } from "./buildUiErrors";
import { deserializeRsglWorkerFailure } from "./buildWorkerFailure";

export interface RsglWorkerCancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface RsglWorkerTransport {
  postMessage(message: RsglWorkerRequestEnvelope): void;
  onceMessage(listener: (response: RsglWorkerResponse) => void): void;
  onceError(listener: (error: Error) => void): void;
  onceExit(listener: (code: number) => void): void;
  removeAllListeners(): void;
  terminate(): Promise<number>;
}

export type RsglWorkerTransportFactory = (workerPath: string) => RsglWorkerTransport;

export interface RsglWorkerTaskOptions {
  workerPath: string;
  cancellationToken?: RsglWorkerCancellationToken;
  createTransport?: RsglWorkerTransportFactory;
}

const neverCancelled: RsglWorkerCancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined })
};

export function runRsglWorkerTask<K extends RsglWorkerTaskKind>(
  request: RsglWorkerRequest<K>,
  options: RsglWorkerTaskOptions
): Promise<RsglWorkerOutcome<K>> {
  const workerPath = requireExplicitWorkerPath(options.workerPath);
  const cancellationToken = options.cancellationToken ?? neverCancelled;
  const createTransport = options.createTransport ?? createNodeWorkerTransport;

  return new Promise((resolve, reject) => {
    const cancellationState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    let transport: RsglWorkerTransport | null = null;
    let settled = false;
    let settling = false;
    let cancelling = false;
    let cancellationSubscription: { dispose(): void } = { dispose: () => undefined };

    const finish = async (
      outcome: RsglWorkerOutcome<K> | null,
      error?: Error,
      terminateTransport = true
    ): Promise<void> => {
      if (settled || settling) {
        return;
      }
      settling = true;
      cancellationSubscription.dispose();
      const completedTransport = transport;
      completedTransport?.removeAllListeners();

      let completionError = error;
      if (terminateTransport && completedTransport) {
        try {
          await completedTransport.terminate();
        } catch (terminationError) {
          completionError ??= toError(terminationError);
        }
      }

      settled = true;
      if (completionError) {
        reject(completionError);
      } else if (outcome) {
        resolve(outcome);
      }
    };

    const cancel = () => {
      if (settled || settling || cancelling) {
        return;
      }
      cancelling = true;
      Atomics.store(cancellationState, 0, 1);
      void finish({ type: "cancelled" });
    };

    cancellationSubscription = cancellationToken.onCancellationRequested(cancel);
    if (settled || settling) {
      cancellationSubscription.dispose();
      return;
    }
    if (cancellationToken.isCancellationRequested) {
      cancel();
      return;
    }

    setImmediate(() => {
      if (settled || settling || cancelling) {
        return;
      }

      try {
        transport = createTransport(workerPath);
        transport.onceMessage(response => {
          void (response.type === "error"
            ? finish(null, deserializeRsglWorkerFailure(response))
            : finish(response as RsglWorkerOutcome<K>));
        });
        transport.onceError(error => void finish(null, error));
        transport.onceExit(code => {
          void (cancelling
            ? finish({ type: "cancelled" }, undefined, false)
            : finish(null, new RsglBuildWorkerExitError(code), false));
        });

        if (cancellationToken.isCancellationRequested) {
          cancel();
          return;
        }
        transport.postMessage({
          request: request as RsglAnyWorkerRequest,
          cancellationBuffer: cancellationState.buffer as SharedArrayBuffer
        });
      } catch (error) {
        void finish(null, toError(error));
      }
    });
  });
}

function createNodeWorkerTransport(workerPath: string): RsglWorkerTransport {
  const worker = new Worker(workerPath);
  return {
    postMessage: message => worker.postMessage(message),
    onceMessage: listener => worker.once("message", listener),
    onceError: listener => worker.once("error", listener),
    onceExit: listener => worker.once("exit", listener),
    removeAllListeners: () => worker.removeAllListeners(),
    terminate: () => worker.terminate()
  };
}

function requireExplicitWorkerPath(workerPath: string): string {
  if (typeof workerPath !== "string" || workerPath.trim().length === 0) {
    throw new TypeError("RSGL workerPath must be an explicit non-empty path.");
  }
  return workerPath;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
