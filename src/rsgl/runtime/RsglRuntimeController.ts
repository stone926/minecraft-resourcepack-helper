import type {
  RsglEnablementMode,
  RsglRuntimeControllerOptions,
  RsglRuntimeEnsureOptions,
  RsglRuntimeInstance,
  RsglRuntimeLoader,
  RsglRuntimeLoadReason,
  RsglRuntimeState,
  RsglRuntimeSuspensionReason
} from "./types";

/**
 * Main-bundle-owned state machine for the physically separate RSGL host entry.
 * It never statically imports the host, compiler, language client, or worker.
 */
export class RsglRuntimeController {
  private state: RsglRuntimeState = { kind: "idle", generation: 0 };
  private mode: RsglEnablementMode;
  private hasActiveProject: boolean;
  private runtime: RsglRuntimeInstance | undefined;
  private loadPromise: Promise<RsglRuntimeInstance | null> | undefined;
  private languageServerPromise: Promise<void> | undefined;
  private languageServerReady = false;
  private loadAbortController: AbortController | undefined;
  private readonly listeners = new Set<(state: RsglRuntimeState) => void>();

  public constructor(
    private readonly loader: RsglRuntimeLoader,
    private readonly options: RsglRuntimeControllerOptions = {}
  ) {
    this.mode = options.mode ?? "auto";
    this.hasActiveProject = options.hasActiveProject ?? false;
    if (options.onStateChange) {
      this.listeners.add(options.onStateChange);
    }
    if (this.mode === "off") {
      this.state = { kind: "suspended", generation: 0, reason: "disabled" };
    } else if (!this.hasActiveProject) {
      this.state = { kind: "suspended", generation: 0, reason: "noActiveProject" };
    }
  }

  public getState(): RsglRuntimeState {
    return this.state;
  }

  public getMode(): RsglEnablementMode {
    return this.mode;
  }

  public onDidChangeState(listener: (state: RsglRuntimeState) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async ensureLoaded(
    reason: RsglRuntimeLoadReason,
    ensureOptions: RsglRuntimeEnsureOptions = {}
  ): Promise<RsglRuntimeInstance | null> {
    if (this.state.kind === "disposed") {
      return null;
    }
    const suspensionReason = this.currentSuspensionReason();
    if (suspensionReason) {
      await this.suspend(suspensionReason);
      return null;
    }
    if (this.runtime && this.state.kind === "ready") {
      return this.runtime;
    }
    if (this.state.kind === "loading" && this.loadPromise) {
      return this.loadPromise;
    }
    if (this.state.kind === "failed" && !ensureOptions.retryFailed) {
      return null;
    }

    return this.beginLoad(reason);
  }

  public retry(reason: RsglRuntimeLoadReason = "manualRefresh"): Promise<RsglRuntimeInstance | null> {
    return this.ensureLoaded(reason, { retryFailed: true });
  }

  public async ensureLanguageServer(
    reason: RsglRuntimeLoadReason = "languageServer",
    ensureOptions: RsglRuntimeEnsureOptions = {}
  ): Promise<RsglRuntimeInstance | null> {
    const runtime = await this.ensureLoaded(reason, ensureOptions);
    if (!runtime?.ensureLanguageServer || this.state.kind !== "ready") {
      return runtime;
    }
    if (this.languageServerReady) {
      return runtime;
    }
    if (!this.languageServerPromise) {
      const generation = this.state.generation;
      const signal = this.loadAbortController?.signal ?? new AbortController().signal;
      const promise = Promise.resolve(runtime.ensureLanguageServer(reason, signal))
        .then(() => {
          if (this.isCurrentReadyRuntime(runtime, generation)) {
            this.languageServerReady = true;
          }
        })
        .catch(async error => {
          if (this.isCurrentReadyRuntime(runtime, generation)) {
            this.runtime = undefined;
            this.languageServerReady = false;
            this.transition({ kind: "failed", generation, reason, error });
            await disposeRuntimeSafely(runtime);
          }
          throw error;
        })
        .finally(() => {
          if (this.languageServerPromise === promise) {
            this.languageServerPromise = undefined;
          }
        });
      this.languageServerPromise = promise;
    }
    await this.languageServerPromise;
    return this.isCurrentReadyRuntime(runtime, this.state.generation) ? runtime : null;
  }

  public async setMode(mode: RsglEnablementMode): Promise<void> {
    if (this.state.kind === "disposed" || this.mode === mode) {
      return;
    }
    this.mode = mode;
    if (mode === "off") {
      await this.suspend("disabled");
      return;
    }
    if (!this.hasActiveProject) {
      await this.suspend("noActiveProject");
      return;
    }

    if (this.state.kind === "ready" || this.state.kind === "loading") {
      await this.options.recheckSignals?.();
      return;
    }

    this.transition({ kind: "idle", generation: this.state.generation });
    await this.options.recheckSignals?.();
    if (mode === "on") {
      await this.ensureLoaded("configuration", { retryFailed: true });
    }
  }

  public async setProjectAvailable(hasActiveProject: boolean): Promise<void> {
    if (this.state.kind === "disposed" || this.hasActiveProject === hasActiveProject) {
      return;
    }
    this.hasActiveProject = hasActiveProject;
    if (!hasActiveProject) {
      await this.suspend("noActiveProject");
      return;
    }
    if (this.mode === "off") {
      await this.suspend("disabled");
      return;
    }

    this.transition({ kind: "idle", generation: this.state.generation });
    await this.options.recheckSignals?.();
    if (this.mode === "on") {
      await this.ensureLoaded("projectMetadata", { retryFailed: true });
    }
  }

  public async projectRevisionChanged(): Promise<void> {
    if (this.state.kind === "disposed") {
      return;
    }
    if (this.runtime && this.state.kind === "ready") {
      await this.runtime.projectRevisionChanged?.();
      return;
    }
    if (this.state.kind === "failed" && this.mode !== "off" && this.hasActiveProject) {
      await this.ensureLoaded("projectRevision", { retryFailed: true });
    }
  }

  public async suspend(reason: RsglRuntimeSuspensionReason): Promise<void> {
    if (this.state.kind === "disposed") {
      return;
    }
    const generation = this.invalidateGeneration();
    const pendingLoad = this.loadPromise;
    const runtime = this.runtime;
    this.runtime = undefined;
    this.languageServerPromise = undefined;
    this.languageServerReady = false;
    this.transition({ kind: "suspended", generation, reason });

    await Promise.all([
      pendingLoad?.catch(() => null),
      runtime ? disposeRuntime(runtime) : Promise.resolve()
    ]);
  }

  /** Terminal extension-host shutdown. VS Code must await this from deactivate. */
  public async dispose(): Promise<void> {
    if (this.state.kind === "disposed") {
      return;
    }
    const generation = this.invalidateGeneration();
    const pendingLoad = this.loadPromise;
    const runtime = this.runtime;
    this.runtime = undefined;
    this.languageServerPromise = undefined;
    this.languageServerReady = false;
    this.transition({ kind: "disposed", generation });
    await Promise.all([
      pendingLoad?.catch(() => null),
      runtime ? disposeRuntime(runtime) : Promise.resolve()
    ]);
  }

  private beginLoad(reason: RsglRuntimeLoadReason): Promise<RsglRuntimeInstance | null> {
    const generation = this.state.generation + 1;
    const abortController = new AbortController();
    this.loadAbortController?.abort();
    this.loadAbortController = abortController;
    this.languageServerReady = false;
    this.transition({ kind: "loading", generation, reason });

    const promise = Promise.resolve(this.loader({
      reason,
      generation,
      signal: abortController.signal
    })).then(async runtime => {
      if (!this.isCurrentLoad(generation, abortController)) {
        await disposeRuntime(runtime);
        return null;
      }
      this.runtime = runtime;
      this.transition({ kind: "ready", generation, reason });
      return runtime;
    }, error => {
      if (this.isCurrentLoad(generation, abortController)) {
        this.transition({ kind: "failed", generation, reason, error });
      }
      throw error;
    }).finally(() => {
      if (this.loadPromise === promise) {
        this.loadPromise = undefined;
      }
    });
    this.loadPromise = promise;
    return promise;
  }

  private invalidateGeneration(): number {
    const generation = this.state.generation + 1;
    this.loadAbortController?.abort();
    this.loadAbortController = undefined;
    return generation;
  }

  private currentSuspensionReason(): RsglRuntimeSuspensionReason | undefined {
    return this.mode === "off"
      ? "disabled"
      : this.hasActiveProject ? undefined : "noActiveProject";
  }

  private isCurrentLoad(generation: number, abortController: AbortController): boolean {
    return this.state.kind === "loading"
      && this.state.generation === generation
      && this.loadAbortController === abortController
      && !abortController.signal.aborted;
  }

  private isCurrentReadyRuntime(runtime: RsglRuntimeInstance, generation: number): boolean {
    return this.state.kind === "ready"
      && this.state.generation === generation
      && this.runtime === runtime;
  }

  private transition(state: RsglRuntimeState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

async function disposeRuntime(runtime: RsglRuntimeInstance): Promise<void> {
  await runtime.dispose();
}

async function disposeRuntimeSafely(runtime: RsglRuntimeInstance): Promise<void> {
  try {
    await disposeRuntime(runtime);
  } catch {
    // Preserve the primary load/LSP failure; shutdown errors are secondary here.
  }
}
