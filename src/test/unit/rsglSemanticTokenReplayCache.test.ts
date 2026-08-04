import * as assert from "node:assert";
import {
  provideRsglSemanticTokens,
  RsglSemanticTokenReplayCache,
  type RsglSemanticTokenSnapshot
} from "../../rsgl/host/semanticTokenReplayCache";

describe("RSGL semantic token replay cache", () => {
  it("replays identical preview text once before returning to the server", () => {
    const cache = new RsglSemanticTokenReplayCache();
    const request = cache.beginRequest("file:///preview.rsgl", "let value = 1");
    cache.store(request, { data: new Uint32Array([0, 4, 5, 4, 0]) });

    cache.prepareOpen("file:///preview.rsgl", "let value = 1");
    assert.strictEqual(
      cache.claimImmediateRefresh("file:///preview.rsgl"),
      true
    );
    assert.strictEqual(
      cache.claimImmediateRefresh("file:///preview.rsgl"),
      false,
      "one reopen must wake the semantic provider only once"
    );
    assert.deepStrictEqual(
      [...(cache.takeReplay("file:///preview.rsgl", "let value = 1")?.data ?? [])],
      [0, 4, 5, 4, 0]
    );
    assert.strictEqual(cache.takeReplay("file:///preview.rsgl", "let value = 1"), null);
  });

  it("returns an identical reopen synchronously and refreshes subsequent requests", () => {
    const cache = new RsglSemanticTokenReplayCache();
    cache.store(cache.beginRequest("file:///preview.rsgl", "text"), {
      data: new Uint32Array([1])
    });
    cache.prepareOpen("file:///preview.rsgl", "text");
    let nextCalls = 0;
    const provide = () => provideRsglSemanticTokens(cache, {
      uri: "file:///preview.rsgl",
      text: "text",
      isCancellationRequested: () => false,
      next: (): RsglSemanticTokenSnapshot => {
        nextCalls++;
        return { data: new Uint32Array([2]) };
      },
      createReplay: snapshot => snapshot
    });

    const replay = provide();
    assert.ok(replay && !(replay instanceof Promise));
    assert.deepStrictEqual([...(replay as RsglSemanticTokenSnapshot).data], [1]);
    assert.strictEqual(nextCalls, 0);

    const refreshed = provide();
    assert.ok(refreshed && !(refreshed instanceof Promise));
    assert.deepStrictEqual([...(refreshed as RsglSemanticTokenSnapshot).data], [2]);
    assert.strictEqual(nextCalls, 1);
  });

  it("does not consume a prepared replay for an already cancelled request", () => {
    const cache = new RsglSemanticTokenReplayCache();
    cache.store(cache.beginRequest("file:///preview.rsgl", "text"), {
      data: new Uint32Array([1])
    });
    cache.prepareOpen("file:///preview.rsgl", "text");
    assert.strictEqual(cache.claimImmediateRefresh("file:///preview.rsgl"), true);
    let cancelled = true;
    const options = {
      uri: "file:///preview.rsgl",
      text: "text",
      isCancellationRequested: () => cancelled,
      next: (): RsglSemanticTokenSnapshot => ({ data: new Uint32Array([2]) }),
      createReplay: (snapshot: RsglSemanticTokenSnapshot) => snapshot
    };

    assert.strictEqual(provideRsglSemanticTokens(cache, options), null);
    assert.strictEqual(cache.claimImmediateRefresh("file:///preview.rsgl"), true);
    cancelled = false;
    const replay = provideRsglSemanticTokens(cache, options);
    assert.deepStrictEqual([...((replay as RsglSemanticTokenSnapshot).data)], [1]);
  });

  it("does not cache a rejected or cancelled asynchronous result", async () => {
    const cache = new RsglSemanticTokenReplayCache();
    const failure = new Error("failed");
    await assert.rejects(async () => provideRsglSemanticTokens(cache, {
      uri: "file:///preview.rsgl",
      text: "text",
      isCancellationRequested: () => false,
      next: () => Promise.reject(failure),
      createReplay: snapshot => snapshot
    }), failure);

    let cancelled = false;
    const pending = provideRsglSemanticTokens(cache, {
      uri: "file:///preview.rsgl",
      text: "text",
      isCancellationRequested: () => cancelled,
      next: async (): Promise<RsglSemanticTokenSnapshot> => ({ data: new Uint32Array([1]) }),
      createReplay: snapshot => snapshot
    });
    cancelled = true;
    await pending;
    cache.prepareOpen("file:///preview.rsgl", "text");
    assert.strictEqual(cache.takeReplay("file:///preview.rsgl", "text"), null);
  });

  it("keeps the newest result when provider promises complete out of order", async () => {
    const cache = new RsglSemanticTokenReplayCache();
    const older = deferred<RsglSemanticTokenSnapshot>();
    const newer = deferred<RsglSemanticTokenSnapshot>();
    const options = (next: () => Promise<RsglSemanticTokenSnapshot>) => ({
      uri: "file:///preview.rsgl",
      text: "text",
      isCancellationRequested: () => false,
      next,
      createReplay: (snapshot: RsglSemanticTokenSnapshot) => snapshot
    });
    const olderResult = provideRsglSemanticTokens(cache, options(() => older.promise));
    const newerResult = provideRsglSemanticTokens(cache, options(() => newer.promise));

    newer.resolve({ data: new Uint32Array([2]) });
    await newerResult;
    older.resolve({ data: new Uint32Array([1]) });
    await olderResult;
    cache.prepareOpen("file:///preview.rsgl", "text");

    assert.deepStrictEqual(
      [...(cache.takeReplay("file:///preview.rsgl", "text")?.data ?? [])],
      [2]
    );
  });

  it("does not revive a pending provider result after global invalidation", async () => {
    const cache = new RsglSemanticTokenReplayCache();
    const pending = deferred<RsglSemanticTokenSnapshot>();
    const result = provideRsglSemanticTokens(cache, {
      uri: "file:///preview.rsgl",
      text: "text",
      isCancellationRequested: () => false,
      next: () => pending.promise,
      createReplay: snapshot => snapshot
    });

    cache.invalidateAll();
    pending.resolve({ data: new Uint32Array([1]) });
    await result;
    cache.prepareOpen("file:///preview.rsgl", "text");
    assert.strictEqual(cache.takeReplay("file:///preview.rsgl", "text"), null);
  });

  it("keeps the last valid snapshot when providers return null or undefined", () => {
    const cache = new RsglSemanticTokenReplayCache();
    cache.store(cache.beginRequest("file:///preview.rsgl", "text"), {
      data: new Uint32Array([1])
    });
    const provideEmpty = (value: null | undefined) =>
      provideRsglSemanticTokens<RsglSemanticTokenSnapshot>(cache, {
        uri: "file:///preview.rsgl",
        text: "text",
        isCancellationRequested: () => false,
        next: () => value,
        createReplay: snapshot => snapshot
      });

    assert.strictEqual(provideEmpty(null), null);
    cache.prepareOpen("file:///preview.rsgl", "text");
    assert.deepStrictEqual(
      [...(cache.takeReplay("file:///preview.rsgl", "text")?.data ?? [])],
      [1]
    );
    assert.strictEqual(provideEmpty(undefined), undefined);
    cache.prepareOpen("file:///preview.rsgl", "text");
    assert.deepStrictEqual(
      [...(cache.takeReplay("file:///preview.rsgl", "text")?.data ?? [])],
      [1]
    );
  });

  it("rejects changed text and pending results from an older generation", () => {
    const cache = new RsglSemanticTokenReplayCache();
    const staleRequest = cache.beginRequest("file:///preview.rsgl", "let value = 1");
    cache.store(staleRequest, { data: new Uint32Array([1]) });

    cache.prepareOpen("file:///preview.rsgl", "let value = 2");
    cache.store(staleRequest, { data: new Uint32Array([2]) });
    cache.prepareOpen("file:///preview.rsgl", "let value = 1");

    assert.strictEqual(cache.takeReplay("file:///preview.rsgl", "let value = 1"), null);
  });

  it("isolates stored and replayed token arrays from callers", () => {
    const cache = new RsglSemanticTokenReplayCache();
    const source = new Uint32Array([0, 1, 2, 3, 4]);
    cache.store(cache.beginRequest("file:///preview.rsgl", "text"), {
      data: source,
      resultId: "result"
    });
    source[0] = 9;

    cache.prepareOpen("file:///preview.rsgl", "text");
    const first = cache.takeReplay("file:///preview.rsgl", "text");
    assert.ok(first);
    assert.strictEqual(first.resultId, "result");
    assert.deepStrictEqual([...first.data], [0, 1, 2, 3, 4]);
    first.data[1] = 9;

    cache.prepareOpen("file:///preview.rsgl", "text");
    assert.deepStrictEqual(
      [...(cache.takeReplay("file:///preview.rsgl", "text")?.data ?? [])],
      [0, 1, 2, 3, 4]
    );
  });

  it("bounds retained previews and refreshes least-recently-used order", () => {
    const cache = new RsglSemanticTokenReplayCache(2);
    cache.store(cache.beginRequest("file:///first.rsgl", "first"), { data: new Uint32Array([1]) });
    cache.store(cache.beginRequest("file:///second.rsgl", "second"), { data: new Uint32Array([2]) });
    cache.prepareOpen("file:///first.rsgl", "first");
    assert.ok(cache.takeReplay("file:///first.rsgl", "first"));
    cache.store(cache.beginRequest("file:///third.rsgl", "third"), { data: new Uint32Array([3]) });

    cache.prepareOpen("file:///second.rsgl", "second");
    cache.prepareOpen("file:///first.rsgl", "first");
    cache.prepareOpen("file:///third.rsgl", "third");
    assert.strictEqual(cache.takeReplay("file:///second.rsgl", "second"), null);
    assert.ok(cache.takeReplay("file:///first.rsgl", "first"));
    assert.ok(cache.takeReplay("file:///third.rsgl", "third"));
  });

  it("does not let an older request overwrite a newer result", () => {
    const cache = new RsglSemanticTokenReplayCache();
    const older = cache.beginRequest("file:///preview.rsgl", "text");
    const newer = cache.beginRequest("file:///preview.rsgl", "text");

    cache.store(newer, { data: new Uint32Array([2]) });
    cache.store(older, { data: new Uint32Array([1]) });
    cache.prepareOpen("file:///preview.rsgl", "text");

    assert.deepStrictEqual(
      [...(cache.takeReplay("file:///preview.rsgl", "text")?.data ?? [])],
      [2]
    );
  });

  it("keeps the last valid snapshot when a newer request is empty", () => {
    const cache = new RsglSemanticTokenReplayCache();
    cache.store(cache.beginRequest("file:///preview.rsgl", "text"), {
      data: new Uint32Array([1])
    });
    cache.complete(cache.beginRequest("file:///preview.rsgl", "text"));
    cache.prepareOpen("file:///preview.rsgl", "text");

    assert.deepStrictEqual(
      [...(cache.takeReplay("file:///preview.rsgl", "text")?.data ?? [])],
      [1]
    );
  });

  it("can disable retention and clears replay eligibility on invalidation", () => {
    const disabled = new RsglSemanticTokenReplayCache(0);
    disabled.store(disabled.beginRequest("file:///preview.rsgl", "text"), {
      data: new Uint32Array([1])
    });
    disabled.prepareOpen("file:///preview.rsgl", "text");
    assert.strictEqual(disabled.takeReplay("file:///preview.rsgl", "text"), null);

    const cache = new RsglSemanticTokenReplayCache();
    cache.store(cache.beginRequest("file:///preview.rsgl", "text"), {
      data: new Uint32Array([1])
    });
    cache.prepareOpen("file:///preview.rsgl", "text");
    cache.invalidateAll();
    assert.strictEqual(cache.takeReplay("file:///preview.rsgl", "text"), null);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}
