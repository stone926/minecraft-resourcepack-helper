import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type {
  RsglAnyWorkerRequest,
  RsglWorkerOutcome,
  RsglWorkerRequest,
  RsglWorkerRequestEnvelope,
  RsglWorkerResponse,
  RsglWorkerTaskKind
} from "./buildWorkerProtocol";

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

export type RsglWorkerTransportFactory = () => RsglWorkerTransport;

const neverCancelled: RsglWorkerCancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined })
};

export function runRsglWorkerTask<K extends RsglWorkerTaskKind>(
  request: RsglWorkerRequest<K>,
  cancellationToken: RsglWorkerCancellationToken = neverCancelled,
  createTransport: RsglWorkerTransportFactory = createNodeWorkerTransport
): Promise<RsglWorkerOutcome<K>> {
  return new Promise((resolve, reject) => {
    const cancellationState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    let transport: RsglWorkerTransport | null = null;
    let settled = false;
    let cancelling = false;
    let cancellationSubscription: { dispose(): void } = { dispose: () => undefined };

    const finish = (outcome: RsglWorkerOutcome<K> | null, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cancellationSubscription.dispose();
      transport?.removeAllListeners();
      if (error) {
        reject(error);
      } else if (outcome) {
        resolve(outcome);
      }
    };

    const cancel = () => {
      if (settled || cancelling) {
        return;
      }
      cancelling = true;
      Atomics.store(cancellationState, 0, 1);
      if (!transport) {
        finish({ type: "cancelled" });
        return;
      }
      void transport.terminate().then(
        () => finish({ type: "cancelled" }),
        error => finish(null, error instanceof Error ? error : new Error(String(error)))
      );
    };

    cancellationSubscription = cancellationToken.onCancellationRequested(cancel);
    if (settled) {
      cancellationSubscription.dispose();
      return;
    }
    if (cancellationToken.isCancellationRequested) {
      cancel();
      return;
    }

    setImmediate(() => {
      if (settled || cancelling) {
        return;
      }

      try {
        transport = createTransport();
      } catch (error) {
        finish(null, error instanceof Error ? error : new Error(String(error)));
        return;
      }

      transport.onceMessage(response => {
        const completedTransport = transport;
        if (response.type === "error") {
          finish(null, workerError(response.message, response.stack));
        } else {
          finish(response as RsglWorkerOutcome<K>);
        }
        void completedTransport?.terminate();
      });
      transport.onceError(error => {
        void transport?.terminate();
        finish(null, error);
      });
      transport.onceExit(code => {
        if (settled) {
          return;
        }
        if (cancelling) {
          finish({ type: "cancelled" });
        } else {
          finish(null, new Error(`RSGL build worker exited before returning a result (code ${code}).`));
        }
      });

      if (cancellationToken.isCancellationRequested) {
        cancel();
        return;
      }
      transport.postMessage({
        request: request as RsglAnyWorkerRequest,
        cancellationBuffer: cancellationState.buffer as SharedArrayBuffer
      });
    });
  });
}

function createNodeWorkerTransport(): RsglWorkerTransport {
  const worker = new Worker(path.join(__dirname, "buildWorker.js"));
  return {
    postMessage: message => worker.postMessage(message),
    onceMessage: listener => worker.once("message", listener),
    onceError: listener => worker.once("error", listener),
    onceExit: listener => worker.once("exit", listener),
    removeAllListeners: () => worker.removeAllListeners(),
    terminate: () => worker.terminate()
  };
}

function workerError(message: string, stack: string | undefined): Error {
  const error = new Error(message);
  if (stack) {
    error.stack = stack;
  }
  return error;
}
