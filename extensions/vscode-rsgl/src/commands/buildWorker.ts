import { parentPort } from "node:worker_threads";
import { executeRsglWorkerTask } from "./buildWorkerTask";
import type {
  RsglAnyWorkerResponse,
  RsglWorkerRequestEnvelope
} from "./buildWorkerProtocol";

const workerPort = parentPort;
if (workerPort) {
  workerPort.once("message", (envelope: RsglWorkerRequestEnvelope) => {
    const cancellationState = new Int32Array(envelope.cancellationBuffer);
    let response: RsglAnyWorkerResponse;
    try {
      response = executeRsglWorkerTask(
        envelope.request,
        () => Atomics.load(cancellationState, 0) !== 0
      );
    } catch (error) {
      response = {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      };
    }
    workerPort.postMessage(response);
    workerPort.close();
  });
}
