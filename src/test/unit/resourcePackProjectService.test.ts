import * as assert from "node:assert";
import {
  normalizeResourceProjectUri,
  resourceProjectUriIdentity,
  resourceProjectUriParent,
  type ResourceProjectFileType,
  type SerializedResourceUri
} from "../../../packages/resource-project/src";
import {
  ResourcePackProjectService,
  type ResourcePackProjectServiceHost,
  type ResourceProjectTextFile,
  type ResourceProjectWorkspaceFolder
} from "../../resourceProject";
import { sharedConfigurationFromSettings } from "../../resourceProject";

describe("resource pack project service", () => {
  it("associates pack/assets and conventional RSGL source with bounded targeted probes", async () => {
    const pack = "file:///workspace/demo-pack";
    const source = `${pack}/rsgl/main.rsgl`;
    const host = new FakeProjectHost([{ uri: pack, configurationRevision: "settings-r1" }]);
    host.setFile(`${pack}/pack.mcmeta`, "{}", "pack-r1");
    host.setFile(source, "model block example {}", "source-r1");
    const service = new ResourcePackProjectService(host);

    const result = await service.resolveProject(source);

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.context?.packRootUri, pack);
    assert.strictEqual(result.context?.assetsRootUri, `${pack}/assets`);
    assert.deepStrictEqual(result.context?.rsglSourceRootUris, [`${pack}/rsgl`]);
    assert.strictEqual(result.rsglApplicability, "conventional");
    assert.strictEqual(
      service.getRsglApplicability(result.context?.projectId ?? "missing"),
      "conventional"
    );
    assert.ok(host.statCalls.length < 16, `expected targeted probes, got ${host.statCalls.length}`);
    assert.strictEqual(await service.resolveProject(source), result, "resolved result should be cached");
  });

  it("uses nearest config root/outDir and workspace-folder-scoped shared layers", async () => {
    const workspace = "file:///workspace";
    const source = "file:///workspace/tooling/rsgl/source/nested/main.rsgl";
    const configUri = "file:///workspace/tooling/rsgl.config.json";
    const outputPack = "file:///workspace/packs/Target%20%E8%B5%84%E6%BA%90%E5%8C%85";
    const sharedConfiguration = sharedConfigurationFromSettings(
      workspace,
      "defaults/vanilla assets",
      ["dependencies/base pack", "file:///archives/extra.zip"]
    );
    const host = new FakeProjectHost([{
      uri: workspace,
      sharedConfiguration,
      configurationRevision: "settings-r2"
    }]);
    host.setFile(source, "", "source-r1");
    host.setFile(configUri, JSON.stringify({
      root: "rsgl/source",
      outDir: "../packs/Target 资源包"
    }), "config-r1");
    host.setFile(`${outputPack}/pack.mcmeta`, "{}", "pack-r1");

    const result = await new ResourcePackProjectService(host).resolveProject(source);

    assert.strictEqual(result.context?.projectRootUri, "file:///workspace/tooling");
    assert.deepStrictEqual(result.context?.rsglSourceRootUris, ["file:///workspace/tooling/rsgl/source"]);
    assert.strictEqual(result.context?.outputPackRootUri, outputPack);
    assert.strictEqual(result.context?.vanillaLayer?.rootUri, "file:///workspace/defaults/vanilla%20assets");
    assert.strictEqual(result.rsglApplicability, "configured");
    assert.deepStrictEqual(result.context?.externalLayers.map(layer => [layer.source, layer.rootUri]), [
      ["directory", "file:///workspace/dependencies/base%20pack"],
      ["zip", "file:///archives/extra.zip"]
    ]);
  });

  it("keeps JSON-only packs non-applicable when conventional roots are absent", async () => {
    const pack = "file:///workspace/json-only-pack";
    const source = `${pack}/assets/demo/models/block/example.json`;
    const host = new FakeProjectHost([{
      uri: pack,
      configurationRevision: "settings-json-only"
    }]);
    host.setFile(source, "{}", "source-r1");
    host.setFile(`${pack}/pack.mcmeta`, "{}", "pack-r1");
    const service = new ResourcePackProjectService(host);

    const result = await service.resolveProject(source);

    assert.ok(result.context);
    assert.deepStrictEqual(result.context.rsglSourceRootUris, [`${pack}/rsgl`]);
    assert.strictEqual(result.rsglApplicability, "none");
    assert.strictEqual(service.getRsglApplicability(result.context.projectId), "none");
    assert.ok(host.statCalls.includes(`${pack}/rsgl`));
    assert.strictEqual(host.workspaceScans, 0);

    host.setFile(`${pack}/rsgl/main.rsgl`, "model block example {}", "rsgl-r1");
    assert.strictEqual(
      service.getRsglApplicability(result.context.projectId),
      "none",
      "the cached lookup must not probe the filesystem"
    );
    assert.deepStrictEqual(service.invalidateUri(`${pack}/rsgl`), [result.context.projectId]);
    assert.strictEqual(service.getRsglApplicability(result.context.projectId), undefined);
    const refreshed = await service.resolveProject(source);
    assert.strictEqual(refreshed.rsglApplicability, "conventional");
  });

  it("detects a conventional remote root with URI-only targeted stats", async () => {
    const pack = "vscode-remote://ssh-remote+builder/work/%E8%B5%84%E6%BA%90%E5%8C%85";
    const source = `${pack}/assets/demo/models/block/example.json`;
    const host = new FakeProjectHost([{
      uri: pack,
      configurationRevision: "settings-remote-probe"
    }]);
    host.setFile(source, "{}", "source-r1");
    host.setFile(`${pack}/pack.mcmeta`, "{}", "pack-r1");
    host.setFile(`${pack}/rsgl/main.rsgl`, "model block example {}", "rsgl-r1");
    const service = new ResourcePackProjectService(host);

    const result = await service.resolveProject(source);

    assert.ok(result.context);
    assert.strictEqual(result.rsglApplicability, "conventional");
    assert.strictEqual(service.getRsglApplicability(result.context.projectId), "conventional");
    assert.ok(host.statCalls.includes(`${pack}/rsgl`));
    assert.ok(host.statCalls.every(uri => uri.startsWith("vscode-remote:")));
    assert.strictEqual(host.workspaceScans, 0);
  });

  it("lets project default/load-order/target fields override workspace settings", async () => {
    const workspace = "file:///workspace";
    const project = `${workspace}/Tooling%20%E5%B7%A5%E7%A8%8B`;
    const source = `${project}/RSGL%20%E6%BA%90/nested/main.rsgl`;
    const configUri = `${project}/rsgl.config.json`;
    const host = new FakeProjectHost([{
      uri: workspace,
      sharedConfiguration: sharedConfigurationFromSettings(
        workspace,
        "settings/default-assets",
        ["settings/ignored-pack"]
      ),
      configurationRevision: "settings-r3"
    }]);
    host.setFile(source, "", "source-r1");
    host.setFile(configUri, JSON.stringify({
      root: "RSGL 源",
      outDir: "Target Pack 资源",
      defaultAssetsPath: "vanilla/client.jar",
      resourcePackRoots: [
        "layers/first pack",
        "layers/second.zip",
        "layers/third.jar"
      ],
      target: { edition: "java", mc: "1.21.4" }
    }), "config-r1");

    const result = await new ResourcePackProjectService(host).resolveProject(source);

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(
      result.context?.outputPackRootUri,
      `${project}/Target%20Pack%20%E8%B5%84%E6%BA%90`
    );
    assert.strictEqual(result.context?.vanillaLayer?.source, "clientJar");
    assert.strictEqual(result.context?.vanillaLayer?.rootUri, `${project}/vanilla/client.jar`);
    assert.deepStrictEqual(result.context?.externalLayers.map(layer => [
      layer.source,
      layer.priority,
      layer.rootUri
    ]), [
      ["directory", 0, `${project}/layers/first%20pack`],
      ["zip", 1, `${project}/layers/second.zip`],
      ["zip", 2, `${project}/layers/third.jar`]
    ]);
    assert.deepStrictEqual(result.context?.targetPackFormat, { major: 46, minor: 0 });
  });

  it("honors explicit null/empty project overrides and exact format targets", async () => {
    const workspace = "file:///workspace";
    const source = `${workspace}/project/rsgl/main.rsgl`;
    const configUri = `${workspace}/project/rsgl.config.json`;
    const host = new FakeProjectHost([{
      uri: workspace,
      sharedConfiguration: sharedConfigurationFromSettings(
        workspace,
        "settings/default-assets",
        ["settings/base-pack"]
      ),
      configurationRevision: "settings-r4"
    }]);
    host.setFile(source, "", "source-r1");
    host.setFile(configUri, JSON.stringify({
      root: "rsgl",
      outDir: "pack",
      defaultAssetsPath: null,
      resourcePackRoots: [],
      target: { edition: "java", format: [88, 2] }
    }), "config-r1");

    const result = await new ResourcePackProjectService(host).resolveProject(source);

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.context?.vanillaLayer, undefined);
    assert.deepStrictEqual(result.context?.externalLayers, []);
    assert.deepStrictEqual(result.context?.targetPackFormat, { major: 88, minor: 2 });
  });

  it("reports invalid canonical target fields instead of silently dropping them", async () => {
    const workspace = "file:///workspace";
    const source = `${workspace}/project/rsgl/main.rsgl`;
    const configUri = `${workspace}/project/rsgl.config.json`;
    const host = new FakeProjectHost([{
      uri: workspace,
      configurationRevision: "settings-r5"
    }]);
    host.setFile(source, "", "source-r1");
    host.setFile(configUri, JSON.stringify({
      root: "rsgl",
      outDir: "pack",
      target: { edition: "java", mc: "1.99.0" }
    }), "config-r1");

    const result = await new ResourcePackProjectService(host).resolveProject(source);

    assert.strictEqual(result.context, undefined);
    assert.strictEqual(result.rsglApplicability, "configured");
    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "resourceProject.invalidConfiguration"
    ]);
    assert.match(result.diagnostics[0].message, /Unknown Minecraft version '1\.99\.0'/);
  });

  it("reports multi-root ambiguity without scanning either workspace", async () => {
    const source = "file:///loose/main.rsgl";
    const first = "file:///packs/first";
    const second = "file:///packs/second";
    const host = new FakeProjectHost([
      { uri: first, configurationRevision: "a" },
      { uri: second, configurationRevision: "b" }
    ]);
    host.setFile(source, "", "source-r1");
    host.setFile(`${first}/pack.mcmeta`, "{}", "pack-a");
    host.setFile(`${second}/pack.mcmeta`, "{}", "pack-b");

    const result = await new ResourcePackProjectService(host).resolveProject(source);

    assert.strictEqual(result.context, undefined);
    assert.strictEqual(result.diagnostics.some(diagnostic =>
      diagnostic.code === "resourceProject.ambiguousPackRoot"
    ), true);
    assert.strictEqual(host.workspaceScans, 0);
  });

  it("preserves remote URIs and non-ASCII config paths", async () => {
    const workspace = "vscode-remote://ssh-remote+dev/work/%E8%B5%84%E6%BA%90%E5%8C%85";
    const source = `${workspace}/sources/%E6%96%B9%E5%9D%97/main.rsgl`;
    const config = `${workspace}/rsgl.config.json`;
    const host = new FakeProjectHost([{
      uri: workspace,
      configurationRevision: "remote-settings"
    }]);
    host.setFile(source, "", "source-r1");
    host.setFile(config, JSON.stringify({
      root: "sources/方块",
      outDir: ".",
      defaultAssetsPath: "默认资源/client.jar",
      resourcePackRoots: ["依赖/基础包", "依赖/覆盖.zip"],
      target: { edition: "java", format: 88 }
    }), "config-r1");
    host.setFile(`${workspace}/pack.mcmeta`, "{}", "pack-r1");

    const result = await new ResourcePackProjectService(host).resolveProject(source);

    assert.strictEqual(result.context?.workspaceFolderUri, workspace);
    assert.deepStrictEqual(result.context?.rsglSourceRootUris, [`${workspace}/sources/%E6%96%B9%E5%9D%97`]);
    assert.strictEqual(
      result.context?.vanillaLayer?.rootUri,
      `${workspace}/%E9%BB%98%E8%AE%A4%E8%B5%84%E6%BA%90/client.jar`
    );
    assert.deepStrictEqual(result.context?.externalLayers.map(layer => layer.rootUri), [
      `${workspace}/%E4%BE%9D%E8%B5%96/%E5%9F%BA%E7%A1%80%E5%8C%85`,
      `${workspace}/%E4%BE%9D%E8%B5%96/%E8%A6%86%E7%9B%96.zip`
    ]);
    assert.deepStrictEqual(result.context?.targetPackFormat, { major: 88, minor: 0 });
    assert.ok(result.dependencyUris.every(uri => uri.startsWith("vscode-remote:")));
  });

  it("invalidates cached config and pack metadata revisions by exact dependency URI", async () => {
    const workspace = "file:///workspace";
    const source = `${workspace}/rsgl/main.rsgl`;
    const config = `${workspace}/rsgl.config.json`;
    const firstPack = `${workspace}/pack-a`;
    const secondPack = `${workspace}/pack-b`;
    const host = new FakeProjectHost([{ uri: workspace, configurationRevision: "settings-r1" }]);
    host.setFile(source, "", "source-r1");
    host.setFile(config, JSON.stringify({ root: "rsgl", outDir: "pack-a" }), "config-r1");
    host.setFile(`${firstPack}/pack.mcmeta`, "{\"pack\":1}", "pack-r1");
    host.setFile(`${secondPack}/pack.mcmeta`, "{\"pack\":2}", "pack-r1");
    const service = new ResourcePackProjectService(host);
    const first = await service.resolveProject(source);

    host.setFile(config, JSON.stringify({ root: "rsgl", outDir: "pack-b" }), "config-r2");
    assert.strictEqual((await service.resolveProject(source)).context?.outputPackRootUri, firstPack);
    assert.deepStrictEqual(service.invalidateUri(config), [first.context?.projectId]);
    const second = await service.resolveProject(source);
    assert.strictEqual(second.context?.outputPackRootUri, secondPack);
    assert.notStrictEqual(second.context?.configurationRevision, first.context?.configurationRevision);

    host.setFile(`${secondPack}/pack.mcmeta`, "{\"pack\":3}", "pack-r2");
    service.invalidateUri(`${secondPack}/pack.mcmeta`);
    const third = await service.resolveProject(source);
    assert.notStrictEqual(third.context?.contextRevision, second.context?.contextRevision);
    assert.notStrictEqual(third.context?.localLayer.metadataRevision, second.context?.localLayer.metadataRevision);
  });

  it("fails safely when the finite stat budget is exhausted", async () => {
    const workspace = "file:///workspace";
    const source = `${workspace}/a/b/c/d/e/f/main.rsgl`;
    const host = new FakeProjectHost([{ uri: workspace, configurationRevision: "settings" }]);
    host.setFile(source, "", "source-r1");
    host.setFile(`${workspace}/pack.mcmeta`, "{}", "pack-r1");

    const result = await new ResourcePackProjectService(host, { maxStatProbes: 4 })
      .resolveProject(source);

    assert.strictEqual(host.statCalls.length, 4);
    assert.strictEqual(result.diagnostics.some(diagnostic =>
      diagnostic.code === "resourceProject.probeLimitExceeded"
    ), true);
  });

  it("routes local and configured-layer target mutations to cached consumer contexts", async () => {
    const pack = "file:///workspace/pack";
    const source = `${pack}/rsgl/main.rsgl`;
    const host = new FakeProjectHost([{
      uri: "file:///workspace",
      configurationRevision: "settings-r1",
      sharedConfiguration: sharedConfigurationFromSettings(
        "file:///workspace",
        undefined,
        ["file:///dependencies/base-pack"]
      )
    }]);
    host.setFile(source, "", "source-r1");
    host.setFile(`${pack}/pack.mcmeta`, "{}", "pack-r1");
    const service = new ResourcePackProjectService(host);
    const result = await service.resolveProject(source);

    assert.deepStrictEqual(service.findCachedContextsForUri(
      `${pack}/assets/demo/models/created.json`
    ).map(context => context.projectId), [result.context?.projectId]);
    assert.deepStrictEqual(service.findCachedContextsForUri(
      "file:///dependencies/base-pack/assets/demo/models/deleted.json"
    ).map(context => context.projectId), [result.context?.projectId]);
    assert.deepStrictEqual(service.findCachedContextsForUri(
      "file:///unrelated/assets/demo/models/other.json"
    ), []);
  });
});

class FakeProjectHost implements ResourcePackProjectServiceHost {
  private readonly files = new Map<string, ResourceProjectTextFile>();
  private readonly directories = new Set<string>();
  public readonly statCalls: string[] = [];
  public workspaceScans = 0;

  public constructor(private readonly workspaces: ResourceProjectWorkspaceFolder[]) {
    for (const workspace of workspaces) {
      this.addDirectory(workspace.uri);
    }
  }

  public setFile(uriValue: string, text: string, revision: string): void {
    const uri = normalizeResourceProjectUri(uriValue);
    this.files.set(resourceProjectUriIdentity(uri), { text, revision });
    const parent = resourceProjectUriParent(uri);
    if (parent) {
      this.addDirectory(parent);
    }
  }

  public async stat(uriValue: SerializedResourceUri): Promise<ResourceProjectFileType | null> {
    const uri = normalizeResourceProjectUri(uriValue);
    this.statCalls.push(uri);
    const identity = resourceProjectUriIdentity(uri);
    return this.files.has(identity) ? "file" : this.directories.has(identity) ? "directory" : null;
  }

  public async readTextFile(uriValue: SerializedResourceUri): Promise<ResourceProjectTextFile | null> {
    return this.files.get(resourceProjectUriIdentity(uriValue)) ?? null;
  }

  public getWorkspaceFolders(): readonly ResourceProjectWorkspaceFolder[] {
    return this.workspaces;
  }

  private addDirectory(uriValue: string): void {
    let uri: string | null = normalizeResourceProjectUri(uriValue);
    while (uri) {
      this.directories.add(resourceProjectUriIdentity(uri));
      uri = resourceProjectUriParent(uri);
    }
  }
}
