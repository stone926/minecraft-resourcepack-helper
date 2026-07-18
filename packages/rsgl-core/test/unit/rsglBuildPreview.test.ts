import * as assert from "node:assert";
import {
  formatRsglBuildPreview,
  type RsglBuildPreviewMessages
} from "../../src/build";
import type { RsglWritePlan } from "../../src/compiler";

describe("RSGL build preview formatter", () => {
  it("preserves the English CLI default", () => {
    const preview = formatRsglBuildPreview(unchangedPlan(), { entryFileName: "src/main.rsgl" });

    assert.match(preview, /^# RSGL Build Preview$/m);
    assert.match(preview, /^Entry: src\/main\.rsgl$/m);
    assert.match(preview, /^Output root: pack$/m);
    assert.match(preview, /^Summary: 0 create, 0 update, 1 unchanged$/m);
    assert.match(preview, /^## Planned Changes$/m);
    assert.match(preview, /^No file changes\.$/m);
  });

  it("formats every piece of generated copy from a serializable message dictionary", () => {
    const messages: RsglBuildPreviewMessages = {
      title: "构建预览",
      entry: "入口：{0}",
      sourceRoot: "源目录：{0}",
      outputRoot: "输出目录：{0}",
      summary: "摘要：新建 {0}，更新 {1}，未变更 {2}",
      plannedChanges: "计划变更",
      noFileChanges: "没有文件变更。",
      diffPreview: "差异预览",
      binaryCopyFrom: "二进制复制源：{0}",
      omittedDiffLines: "省略 {0} 行",
      statusCreate: "新建",
      statusUpdate: "更新",
      statusUnchanged: "未变更"
    };
    const plan: RsglWritePlan = {
      outputRoot: "pack",
      entries: [
        {
          outputPath: "generated.txt",
          absolutePath: "pack/generated.txt",
          content: "one\ntwo\nthree",
          kind: "resource",
          status: "create",
          diff: { addedLines: 3, removedLines: 0 }
        },
        {
          outputPath: "pack.png",
          absolutePath: "pack/pack.png",
          copyFrom: "source/pack.png",
          kind: "resource",
          status: "update"
        }
      ],
      summary: { create: 1, update: 1, unchanged: 0 }
    };

    const preview = formatRsglBuildPreview(plan, {
      entryFileName: "src/main.rsgl",
      sourceRoot: "src",
      maxDiffLinesPerFile: 2,
      messages
    });

    assert.match(preview, /^# 构建预览$/m);
    assert.match(preview, /^入口：src\/main\.rsgl$/m);
    assert.match(preview, /^源目录：src$/m);
    assert.match(preview, /^输出目录：pack$/m);
    assert.match(preview, /^摘要：新建 1，更新 1，未变更 0$/m);
    assert.match(preview, /^## 计划变更$/m);
    assert.match(preview, /^- 新建: generated\.txt \(\+3 -0\)$/m);
    assert.match(preview, /^- 更新: pack\.png$/m);
    assert.match(preview, /^## 差异预览$/m);
    assert.match(preview, /^省略 2 行$/m);
    assert.match(preview, /^二进制复制源：source\/pack\.png$/m);
    assert.doesNotMatch(preview, /RSGL Build Preview|Entry:|Planned Changes|Binary copy from|omitted/);

    const noChanges = formatRsglBuildPreview(unchangedPlan(), { messages });
    assert.match(noChanges, /^没有文件变更。$/m);
  });
});

function unchangedPlan(): RsglWritePlan {
  return {
    outputRoot: "pack",
    entries: [
      {
        outputPath: "same.json",
        absolutePath: "pack/same.json",
        content: "{}",
        kind: "resource",
        status: "unchanged"
      }
    ],
    summary: { create: 0, update: 0, unchanged: 1 }
  };
}
