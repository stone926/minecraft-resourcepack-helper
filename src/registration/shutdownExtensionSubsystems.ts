import type * as vscode from "vscode";

export interface AsyncShutdown {
  shutdown(): Promise<void>;
}

/** Shuts down independent owners without letting one failure skip the other. */
export async function shutdownExtensionSubsystems(
  resourceSurfaces: vscode.Disposable | undefined,
  rsglSubsystem: AsyncShutdown | undefined
): Promise<void> {
  const errors: unknown[] = [];
  try {
    resourceSurfaces?.dispose();
  } catch (error) {
    errors.push(error);
  }
  try {
    await rsglSubsystem?.shutdown();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Extension subsystems could not be shut down cleanly");
  }
}
