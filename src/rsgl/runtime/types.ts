export type RsglEnablementMode = "auto" | "on" | "off";

export type RsglRuntimeLoadReason =
  | "openDocument"
  | "visibleDocument"
  | "command"
  | "projectMetadata"
  | "graphExpansion"
  | "manualRefresh"
  | "configuration"
  | "projectRevision"
  | "languageServer";

export type RsglRuntimeSuspensionReason = "disabled" | "noActiveProject";

export type RsglRuntimeState =
  | { kind: "idle"; generation: number }
  | { kind: "loading"; generation: number; reason: RsglRuntimeLoadReason }
  | { kind: "ready"; generation: number; reason: RsglRuntimeLoadReason }
  | { kind: "failed"; generation: number; reason: RsglRuntimeLoadReason; error: unknown }
  | { kind: "suspended"; generation: number; reason: RsglRuntimeSuspensionReason }
  | { kind: "disposed"; generation: number };

export interface RsglRuntimeLoadRequest {
  reason: RsglRuntimeLoadReason;
  generation: number;
  signal: AbortSignal;
}

/** Narrow root-to-lazy-host lifetime boundary. */
export interface RsglRuntimeInstance {
  ensureLanguageServer?(reason: RsglRuntimeLoadReason, signal: AbortSignal): Promise<void>;
  projectRevisionChanged?(): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export type RsglRuntimeLoader = (
  request: RsglRuntimeLoadRequest
) => Promise<RsglRuntimeInstance>;

export interface RsglRuntimeControllerOptions {
  mode?: RsglEnablementMode;
  hasActiveProject?: boolean;
  /** Re-evaluates already-open/visible documents after off -> auto/on. */
  recheckSignals?: () => void | Promise<void>;
  onStateChange?: (state: RsglRuntimeState) => void;
}

export interface RsglRuntimeEnsureOptions {
  /** Failed loads retry only for explicit/configuration/project-revision signals. */
  retryFailed?: boolean;
}
