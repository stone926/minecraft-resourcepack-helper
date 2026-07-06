# RSGL Real-Pack E2E Improvement Plan

基线样本：`docs/plan/rsgl-e2e-better-textures/`

源资源包：`E:/.minecraft/resourcepacks/better_textures`

## 主要发现

### 1. 目标版本与现代 item definition 冲突

[x] 已完成：旧版 target 下的现代 item definition 会走 legacy item backend；无法表达的 `has_component`/component condition 会产生 `rsgl.unsupportedLegacyItemModel` error，且不会产出错误的 legacy item model 文件。已补 `rejects component conditions in the legacy item backend` 回归测试。

原包 `pack.mcmeta` 是 `pack_format: 50`，但包含现代 `assets/minecraft/items/*.json` item model definition。若 RSGL 使用 `target java format 50`，编译器会走 legacy item lowering，并拒绝嵌套 component condition。

样本使用：

```rsgl
target java format [75, 0]
```

如果混合使用了现代和 legacy，应当给出 error/exception 报错并编译失败

### 2. OptiFine 与任意 JSON 输出缺失

[x] 已完成：新增 `json` resource kind，支持 `json "assets/<namespace>/optifine/....json" { ... }` 这类 pack-relative JSON 输出，也支持 `json namespace:path { ... }` 输出到 `assets/<namespace>/<path>.json`；保留 JSON emit、字段排序、结构 source map、补全和语法高亮，并拒绝不安全路径。

原包有 152 个 `assets/minecraft/optifine/models/**/*.json`。当前 RSGL 的 resource kind 都映射到 vanilla 资源路径，不能原生输出 `assets/<namespace>/optifine/**` JSON。

`text "assets/...json"` 可以绕过写出文本，但会失去 JSON emit、字段排序、JSON 结构 source map、resource kind 校验和补全。这不适合作为真实资源 DSL 的主路径。

### 3. 复杂模型几何缺少高层 DSL

[x] 已完成：新增 model body 内的 `texture`、`box`/`element` 几何 DSL，支持 `all`/方向 face shortcut、`uv`、`cullface`、`rotation`、`shade`、`light_emission`、`mirror`、`translate`，并为 `/elements/<index>/faces/<face>/...` 生成更细 source map。补充 parser/compiler/grammar/completion 单测。

大量模型包含 `elements`、`faces`、`uv`、`rotation`、`cullface`。当前可以用 `raw_json` 表达，但问题是：

- 复用粒度停留在整个 JSON fragment。
- source map 对复杂对象的定位偏粗。
- 很难写出可读的几何模板，例如门、栅栏门、cauldron、hopper、campfire。
- 很难表达镜像、重复 box、面模板、UV 模式和旋转族。

### 4. 序列格式控制不足

[x] 已完成：`{0..11}` 默认生成无 padding 的 `0..11`，显式 `pad: 2` 才生成 `00..11`；`seq(...)` 和 `particlesSeq(...)` 均支持 padding 控制，并会对非法 padding 给出诊断。

真实粒子纹理是 `big_smoke_0..11`。`particlesSeq("...{0..11}")` 在该样本里生成了 `00..09`，与真实文件不匹配。当前缺少显式 padding 控制。

### 5. 虚拟 vanilla 模型父级误报

[x] 已完成：模型父链验证现在会在 `minecraft:builtin/...` 虚拟 vanilla builtin 父级处停止，不再把 `minecraft:builtin/generated` 当作缺失模型；普通缺失 parent 仍会照常诊断。

`minecraft:item/generated` 的父链会到 `minecraft:builtin/generated`。当前验证器把这个虚拟父级当成缺失模型，产生 warning。

这会影响真实包中的大量 item generated 模型。

### 6. LSP 与 build 的程序级语义需要对齐

[x] 已完成：LSP server 已切到 `RsglWorkspaceSemanticCache` + `compileRsglProgram` 的程序级校验路径，支持打开文档覆盖、import graph 加载、watched file 失效刷新，并在 completion/hover 中合入程序符号。

CLI directory build 会加载整个 RSGL source root，能处理跨文件 imports/templates。LSP server 当前校验入口更偏单文档，虽然不会阻断 build，但它不能作为“构建结果完整性”的等价验证。

真实端到端测试需要覆盖：

- 单文件诊断
- 跨文件 import/template 诊断
- VS Code build/preview 命令
- LSP server 与 in-process fallback 的行为一致性

## 改进路线

### 修复虚拟 vanilla builtin 父模型

[x] 已完成。

需求：

- `minecraft:builtin/generated`、`minecraft:builtin/entity` 等虚拟父模型不应报 `modelNotFound`。
- 对 `minecraft:item/generated` 的父链解析应能在默认资产和虚拟内建之间正确停止。

入口位置：

- `packages/rsgl-core/src/compiler/modelStructureValidation.ts`
- `packages/rsgl-core/src/compiler/validation.ts`
- `packages/rsgl-core/src/workspaceValidation.ts`

验收：

- 样本 `check` 无 warning。
- `model item ... parent minecraft:item/generated` 不误报。
- 真实默认 assets 缺失时仍能报告真正缺失的普通 parent。

### 增加模型几何 DSL

[x] 已完成。

候选方向：

```rsgl
model block fence_gate_wall_open {
  texture texture minecraft:block/oak_planks
  texture color minecraft:block/orange_concrete

  box "left-hand post" from [0, 2, 7] to [2, 13, 9] {
    all texture "#texture"
    west cullface west
  }

  boxSet mirrored_x {
    from [0, 0, 6]
    to [0.5, 13, 6.5]
    texture "#color"
  }
}
```

第一版可只覆盖高频需求：

- `box` / `element`
- `face` shortcut
- `all` faces shortcut
- `rotation`
- `cullface`
- `shade`
- reusable face/uv presets
- mirror/translate helpers

入口位置：

- `packages/rsgl-core/src/parser/types.ts`
- `packages/rsgl-core/src/parser/parser.ts`
- `packages/rsgl-core/src/compiler/compiler.ts`
- `packages/rsgl-core/src/compiler/modelStructureValidation.ts`
- `packages/rsgl-core/src/formatterCore.ts`
- `packages/rsgl-core/src/completionData.ts`
- `extensions/vscode-rsgl/syntaxes/rsgl.tmLanguage.json`

验收：

- 至少能把 cauldron/hopper/fence gate/crop label 这类真实模型的 `elements` 压到原 JSON 的 40% 以下。
- source map 能定位到具体 element/face。
- 输出仍是标准模型 JSON。

### 改进序列、range 和 glob 表达

[x] 已完成。

需求：

- 支持无 padding、有 padding、固定宽度和自定义格式。
- `particlesSeq` 不应隐式选择不透明的 padding 规则。

候选语法：

```rsgl
seq(`minecraft:signal/big_smoke_${i}`, i: 0..11)
seq(`minecraft:particle/explosion_${i}`, i: 0..2, pad: 2)
```

入口位置：

- `packages/rsgl-core/src/compiler/sequences.ts`
- `packages/rsgl-core/src/compiler/jsonResourceFragments.ts`
- `packages/rsgl-core/src/semantic/builtins.ts`
- `packages/rsgl-core/test/unit/rsglCompiler.test.ts`

验收：

- `0..11` 可生成 `0,1,...,11`。
- `pad: 2` 可生成 `00,01,...,11`。
- 诊断能指向具体展开项。

### Program-aware LSP 与 VS Code 行为对齐

[x] 已完成。

需求：

- LSP server 校验当前文档时应加载相关 import graph 或 source root。
- 打开未保存文件时应使用内存文本覆盖磁盘版本。
- completion/hover/diagnostics 应理解跨文件 template、fragment、table。

入口位置：

- `packages/rsgl-lsp/src/server.ts`
- `packages/rsgl-core/src/workspaceSource.ts`
- `packages/rsgl-core/src/workspaceSemantic.ts`
- `extensions/vscode-rsgl/src/client.ts`
- `extensions/vscode-rsgl/src/languageFeatures.ts`

验收：

- 打开 `blocks.rsgl` 时，LSP 能看到 `_templates.rsgl` 中的 `slabSet/stairSet/doorState/trapdoorState`。
- LSP diagnostics 与 VS Code build command 在跨文件错误上保持一致。
- 修改 `_templates.rsgl` 后，依赖文件诊断会失效刷新。
