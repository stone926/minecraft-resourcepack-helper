import type * as vscode from "vscode";

export interface DeferredRegistrationScheduler<THandle> {
  schedule(callback: () => void): THandle;
  cancel(handle: THandle): void;
}

/** Owns one cancellable next-turn registration without hiding synchronous failures. */
export class DeferredRegistrationOwner<THandle, TResult = void> implements vscode.Disposable {
  private handle: THandle | undefined;
  private scheduled = false;
  private installing = false;
  private installation: { value: TResult } | undefined;
  private disposed = false;

  public constructor(
    private readonly install: () => TResult,
    private readonly scheduler: DeferredRegistrationScheduler<THandle>,
    private readonly onDeferredError: (error: unknown) => void,
    private readonly disposeInstallation: (installation: TResult) => void = () => undefined,
    private readonly afterInstall: (installation: TResult) => void = () => undefined
  ) {}

  public get isInstalled(): boolean {
    return this.installation !== undefined;
  }

  public start(installImmediately: boolean): void {
    if (this.disposed || this.installation || this.scheduled) {
      return;
    }
    if (installImmediately) {
      this.ensureInstalled();
      return;
    }

    this.scheduled = true;
    try {
      this.handle = this.scheduler.schedule(() => {
        this.scheduled = false;
        this.handle = undefined;
        if (this.disposed) {
          return;
        }
        try {
          this.ensureInstalled();
        } catch (error) {
          this.onDeferredError(error);
        }
      });
    } catch (error) {
      this.scheduled = false;
      this.handle = undefined;
      throw error;
    }
  }

  /** Installs synchronously for command, document, or view signals. */
  public ensureInstalled(): TResult {
    if (this.disposed) {
      throw new Error("Deferred registration has been disposed");
    }
    if (this.installation) {
      return this.installation.value;
    }
    if (this.installing) {
      throw new Error("Deferred registration cannot be entered recursively");
    }
    this.cancelScheduled();
    this.installing = true;
    try {
      const value = this.install();
      this.installation = { value };
      try {
        this.afterInstall(value);
      } catch (error) {
        this.installation = undefined;
        try {
          this.disposeInstallation(value);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Deferred registration publication and rollback both failed",
            { cause: cleanupError }
          );
        }
        throw error;
      }
      return value;
    } finally {
      this.installing = false;
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelScheduled();
    const installation = this.installation;
    this.installation = undefined;
    if (installation) {
      this.disposeInstallation(installation.value);
    }
  }

  private cancelScheduled(): void {
    if (!this.scheduled) {
      return;
    }
    this.scheduler.cancel(this.handle as THandle);
    this.scheduled = false;
    this.handle = undefined;
  }
}
