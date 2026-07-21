import * as assert from "node:assert";
import type {
  Disposable,
  Event,
  TreeDataProvider,
  TreeItem
} from "vscode";
import { DeferredResourceGraphTreeProvider } from "../../registration/deferredResourceGraphTreeProvider";

describe("deferred resource graph tree provider", () => {
  it("resolves the real provider once across its first requests", async () => {
    const changes = new TestEvent<number | number[] | undefined | null | void>();
    let resolutions = 0;
    const provider: TreeDataProvider<number> = {
      onDidChangeTreeData: changes.event,
      getTreeItem: element => ({ id: `item-${element}` } as TreeItem),
      getChildren: element => [element ?? 1]
    };
    const deferred = new DeferredResourceGraphTreeProvider(() => {
      resolutions += 1;
      return provider;
    });

    assert.deepStrictEqual(await deferred.getChildren(), [1]);
    assert.deepStrictEqual(deferred.getTreeItem(2), { id: "item-2" });
    assert.deepStrictEqual(await deferred.getChildren(3), [3]);
    assert.strictEqual(resolutions, 1);
    assert.strictEqual(changes.listenerCount, 1);
  });

  it("forwards refresh events from the resolved provider", async () => {
    const changes = new TestEvent<string | string[] | undefined | null | void>();
    const provider: TreeDataProvider<string> = {
      onDidChangeTreeData: changes.event,
      getTreeItem: element => ({ label: element } as TreeItem),
      getChildren: () => []
    };
    const deferred = new DeferredResourceGraphTreeProvider(() => provider);
    const forwarded: Array<string | string[] | undefined | null | void> = [];
    deferred.onDidChangeTreeData(event => forwarded.push(event));

    await deferred.getChildren();
    changes.fire("refreshed");
    changes.fire(undefined);

    assert.deepStrictEqual(forwarded, ["refreshed", undefined]);
  });

  it("disconnects refresh forwarding when disposed", async () => {
    const changes = new TestEvent<number | number[] | undefined | null | void>();
    const provider: TreeDataProvider<number> = {
      onDidChangeTreeData: changes.event,
      getTreeItem: element => ({ id: String(element) } as TreeItem),
      getChildren: () => []
    };
    const deferred = new DeferredResourceGraphTreeProvider(() => provider);
    let forwarded = 0;
    deferred.onDidChangeTreeData(() => { forwarded += 1; });

    await deferred.getChildren();
    deferred.dispose();
    deferred.dispose();
    changes.fire(1);

    assert.strictEqual(forwarded, 0);
    assert.strictEqual(changes.listenerCount, 0);
  });
});

class TestEvent<T> {
  private readonly listeners = new Set<(event: T) => unknown>();

  public readonly event: Event<T> = (listener, thisArg, disposables) => {
    const callback = thisArg === undefined
      ? listener
      : (event: T) => listener.call(thisArg, event);
    this.listeners.add(callback);
    const disposable: Disposable = {
      dispose: () => this.listeners.delete(callback)
    };
    disposables?.push(disposable);
    return disposable;
  };

  public get listenerCount(): number {
    return this.listeners.size;
  }

  public fire(event: T): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}
