import * as assert from "node:assert";
import type { RsglBuildPreviewResult } from "../../../../packages/rsgl-core/src/build";
import {
  formatWorkspaceBuildPreview,
  type RsglWorkspaceBuildEntry,
  type RsglWorkspaceBuildPreviewMessages
} from "../../src/commands/workspaceBuildPreview";

describe("RSGL workspace build preview", () => {
  it("formats all extension-owned copy through injected messages", () => {
    const entries: Array<RsglWorkspaceBuildEntry<RsglBuildPreviewResult>> = [
      {
        context: {
          sourceRoot: "C:\\packs\\first source",
          sourceFileName: "C:\\packs\\first source\\main.rsgl",
          outputRoot: "C:\\packs\\first"
        },
        result: {
          diagnostics: [],
          dependencies: [],
          plan: {
            outputRoot: "C:\\packs\\first",
            entries: [],
            summary: { create: 2, update: 1, unchanged: 3 }
          },
          preview: "# 内层预览\n正文"
        }
      },
      {
        context: {
          sourceRoot: "C:\\packs\\second source",
          sourceFileName: "C:\\packs\\second source\\main.rsgl",
          outputRoot: "C:\\packs\\second"
        },
        result: {
          diagnostics: [],
          dependencies: [],
          plan: {
            outputRoot: "C:\\packs\\second",
            entries: [],
            summary: { create: 0, update: 2, unchanged: 4 }
          },
          preview: ""
        }
      }
    ];
    const messages: RsglWorkspaceBuildPreviewMessages = {
      title: "工作区构建预览",
      summary: (roots, created, updated, unchanged, skipped) =>
        `摘要：${roots}/${created}/${updated}/${unchanged}/${skipped}`,
      skippedSourceDirectories: "已跳过的源目录",
      missingOutputRoot: "缺少输出根目录。",
      noPreview: "没有预览。"
    };

    const preview = formatWorkspaceBuildPreview(entries, [
      { sourceRoot: "C:\\packs\\skipped", reason: "missingOutputRoot" }
    ], messages);

    assert.match(preview, /^# 工作区构建预览/m);
    assert.match(preview, /摘要：2\/2\/3\/7\/1/);
    assert.match(preview, /^## 已跳过的源目录$/m);
    assert.match(preview, /C:\\packs\\skipped: 缺少输出根目录。/);
    assert.match(preview, /^## 内层预览$/m);
    assert.match(preview, /没有预览。/);
    assert.doesNotMatch(preview, /missingOutputRoot|No preview|Skipped Source Directories/);
  });
});
