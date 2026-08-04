export interface RsglSemanticTokenSnapshot {
  readonly data: Uint32Array;
  readonly resultId?: string;
}

export interface RsglSemanticTokenReplayRequest {
  readonly generation: number;
  readonly requestId: number;
  readonly uri: string;
  readonly text: string;
}

export interface RsglSemanticTokenReplayProviderOptions<T extends RsglSemanticTokenSnapshot> {
  readonly uri: string;
  readonly text: string;
  readonly isCancellationRequested: () => boolean;
  readonly next: () => T | null | undefined | PromiseLike<T | null | undefined>;
  readonly createReplay: (snapshot: RsglSemanticTokenSnapshot) => T;
}

interface RsglSemanticTokenReplayEntry extends RsglSemanticTokenSnapshot {
  readonly text: string;
  readonly requestId: number;
}

const defaultMaximumEntries = 32;

/**
 * Retains the last semantic-token result for recently viewed RSGL documents.
 * A result may be replayed only once after a new open lifecycle with identical
 * text; later provider requests continue to the language server normally.
 */
export class RsglSemanticTokenReplayCache {
  private readonly entries = new Map<string, RsglSemanticTokenReplayEntry>();
  private readonly replayableUris = new Set<string>();
  private readonly refreshRequestedUris = new Set<string>();
  private readonly latestRequestIds = new Map<string, number>();
  private readonly maximumEntries: number;
  private generation = 0;
  private nextRequestId = 1;

  public constructor(maximumEntries = defaultMaximumEntries) {
    this.maximumEntries = normalizeMaximumEntries(maximumEntries);
  }

  /** Marks an identical reopen as eligible for one immediate token replay. */
  public prepareOpen(uri: string, text: string): void {
    const cached = this.entries.get(uri);
    if (!cached || cached.text !== text) {
      this.invalidateUri(uri);
      return;
    }
    this.replayableUris.add(uri);
    this.refreshRequestedUris.delete(uri);
  }

  /** Claims the zero-delay provider refresh once for one prepared reopen. */
  public claimImmediateRefresh(uri: string): boolean {
    if (
      !this.replayableUris.has(uri)
      || this.refreshRequestedUris.has(uri)
      || !this.entries.has(uri)
    ) {
      return false;
    }
    this.refreshRequestedUris.add(uri);
    return true;
  }

  /** Allows a cancelled zero-delay request to be signalled again. */
  public releaseImmediateRefresh(uri: string): void {
    this.refreshRequestedUris.delete(uri);
  }

  /** Returns an isolated snapshot once, then lets subsequent requests refresh. */
  public takeReplay(uri: string, text: string): RsglSemanticTokenSnapshot | null {
    if (!this.replayableUris.delete(uri)) {
      return null;
    }
    this.refreshRequestedUris.delete(uri);
    const cached = this.entries.get(uri);
    if (!cached || cached.text !== text) {
      this.invalidateUri(uri);
      return null;
    }
    this.touch(uri, cached);
    return cloneSnapshot(cached);
  }

  /** Captures the cache generation so invalidated asynchronous results stay out. */
  public beginRequest(uri: string, text: string): RsglSemanticTokenReplayRequest {
    return {
      generation: this.generation,
      requestId: this.recordRequest(uri),
      uri,
      text
    };
  }

  public store(
    request: RsglSemanticTokenReplayRequest,
    snapshot: RsglSemanticTokenSnapshot
  ): void {
    if (
      request.generation !== this.generation
      || request.requestId !== this.currentRequestId(request.uri)
    ) {
      return;
    }
    if (this.maximumEntries === 0) {
      this.latestRequestIds.delete(request.uri);
      return;
    }
    const entry = {
      text: request.text,
      requestId: request.requestId,
      ...cloneSnapshot(snapshot)
    };
    this.entries.delete(request.uri);
    this.entries.set(request.uri, entry);
    this.latestRequestIds.delete(request.uri);
    this.trim();
  }

  /** Completes a cancelled, failed, or empty request without replacing tokens. */
  public complete(request: RsglSemanticTokenReplayRequest): void {
    if (
      request.generation === this.generation
      && this.latestRequestIds.get(request.uri) === request.requestId
    ) {
      this.latestRequestIds.delete(request.uri);
    }
  }

  public invalidateAll(): void {
    this.generation++;
    this.entries.clear();
    this.replayableUris.clear();
    this.refreshRequestedUris.clear();
    this.latestRequestIds.clear();
  }

  private invalidateUri(uri: string): void {
    this.entries.delete(uri);
    this.replayableUris.delete(uri);
    this.refreshRequestedUris.delete(uri);
    this.latestRequestIds.delete(uri);
  }

  private recordRequest(uri: string): number {
    const requestId = this.nextRequestId++;
    this.latestRequestIds.set(uri, requestId);
    return requestId;
  }

  private currentRequestId(uri: string): number | undefined {
    return this.latestRequestIds.get(uri) ?? this.entries.get(uri)?.requestId;
  }

  private touch(uri: string, entry: RsglSemanticTokenReplayEntry): void {
    this.entries.delete(uri);
    this.entries.set(uri, entry);
  }

  private trim(): void {
    while (this.entries.size > this.maximumEntries) {
      const oldestUri = this.entries.keys().next().value as string | undefined;
      if (!oldestUri) {
        return;
      }
      this.entries.delete(oldestUri);
      this.replayableUris.delete(oldestUri);
      this.refreshRequestedUris.delete(oldestUri);
      this.latestRequestIds.delete(oldestUri);
    }
  }
}

/** Replays synchronously on a hit and records the normal provider otherwise. */
export function provideRsglSemanticTokens<T extends RsglSemanticTokenSnapshot>(
  cache: RsglSemanticTokenReplayCache,
  options: RsglSemanticTokenReplayProviderOptions<T>
): T | null | undefined | Promise<T | null | undefined> {
  if (options.isCancellationRequested()) {
    cache.releaseImmediateRefresh(options.uri);
    return null;
  }
  const replay = cache.takeReplay(options.uri, options.text);
  if (replay) {
    return options.createReplay(replay);
  }

  const request = cache.beginRequest(options.uri, options.text);
  let result: ReturnType<RsglSemanticTokenReplayProviderOptions<T>["next"]>;
  try {
    result = options.next();
  } catch (error) {
    cache.complete(request);
    throw error;
  }
  if (isThenable(result)) {
    return Promise.resolve(result).then(value => {
      retainResolvedResult(cache, request, options.isCancellationRequested, value);
      return value;
    }, error => {
      cache.complete(request);
      throw error;
    });
  }
  retainResolvedResult(cache, request, options.isCancellationRequested, result);
  return result;
}

function retainResolvedResult<T extends RsglSemanticTokenSnapshot>(
  cache: RsglSemanticTokenReplayCache,
  request: RsglSemanticTokenReplayRequest,
  isCancellationRequested: () => boolean,
  result: T | null | undefined
): void {
  if (result && !isCancellationRequested()) {
    cache.store(request, result);
  } else {
    cache.complete(request);
  }
}

function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return Boolean(value && typeof (value as Partial<PromiseLike<T>>).then === "function");
}

function cloneSnapshot(snapshot: RsglSemanticTokenSnapshot): RsglSemanticTokenSnapshot {
  return {
    data: snapshot.data.slice(),
    ...(snapshot.resultId === undefined ? {} : { resultId: snapshot.resultId })
  };
}

function normalizeMaximumEntries(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : defaultMaximumEntries;
}
