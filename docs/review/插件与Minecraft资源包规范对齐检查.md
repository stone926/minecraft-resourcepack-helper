# 插件与 Minecraft 资源包规范对齐检查

检查日期：2026-06-29

对照文档：`docs/Minecraft资源包规范完整手册.md`

范围：仅检查 Java 版资源包；不纳入手册第 30 章的基岩版内容。

## 总体结论

插件已经覆盖了 Java 资源包制作中最常用的辅助面：`pack.mcmeta` 和多类 JSON Schema 校验、方块状态/模型/纹理/粒子/物品模型/图集/装备/字体/路径点/后处理/声音的引用跳转与补全、缺失资源诊断、默认原版资源回退、叠加目录到主资源包的回退，以及模型纹理变量继承查找。

但插件还没有完全对齐手册约束。主要问题集中在：

- 新版 `assets/<namespace>/items/*.json` 物品模型映射 schema 与手册结构不一致，会误报合法文件。
- `blockstates`、`pack.mcmeta`、`atlases`、`font`、`.png.mcmeta` 等 schema 仍有字段、必填关系、条件约束缺失。
- 运行时资源解析没有完整实现资源包加载语义，例如 `filter`、叠加版本选择、多资源包加载顺序、语言/声音合并规则。
- 部分手册目录和非 JSON 资源没有诊断，例如 `pack.png`、色彩映射图片尺寸、文本文件特殊规则、声音文件声道/格式。
- 脚手架目录和默认资源包格式版本没有完全跟上手册中的 26.2 / 资源包格式 88.0 口径。

## 已对齐的能力

- `package.json` 已贡献大多数核心 JSON Schema：`pack.mcmeta`、`blockstates`、`models/block`、`models/item`、`particles`、`items`、`atlases`、`equipment`、`font`、`waypoint_style`、`post_effect`、`sounds.json`、语言、credits、GPU 警告、地区合规、纹理 `.png.mcmeta`。
- `src/utils/resourceReferences.ts` 已抽取多类引用：模型父级、模型纹理、方块状态模型、粒子纹理、物品模型映射中的模型/特殊纹理、图集纹理、装备纹理、字体文件、路径点精灵图、后处理 shader/输入纹理、声音文件、shader `#moj_import`。
- `src/diagnostics/resourceDiagnostics.ts` 已对抽取到的资源路径做缺失资源诊断。
- `src/utils/resourceLocation.ts` 已实现 Java 版资源位置字符约束，支持省略 `minecraft:` 命名空间，并阻止 `..` 路径穿越。
- `src/utils/modelTexture.ts` 与 `src/decorator/textureVarDecorator.ts` 已支持模型纹理变量跳转和父模型继承链查找。
- `src/utils/resourceGraph.ts` 与 `src/views/resourceGraphTree.ts` 已提供当前文件引用、反向引用和模型继承关系视图。

## 高优先级问题

### 1. 新版物品模型映射 `property` 结构与手册不一致（已完成）

手册第 11 章示例中，`minecraft:condition`、`minecraft:select`、`minecraft:range_dispatch` 的 `property` 是对象，例如：

```json
{
  "type": "minecraft:condition",
  "property": {
    "type": "minecraft:damaged"
  }
}
```

当前 `assets/linters/items.json` 把 `property` 定义为字符串枚举，并把 `component`、`index`、`target` 等参数放在模型对象同级。这会导致符合手册的新版文件被 schema 误报。

建议：

- 将 `property` 改为对象结构，至少包含 `type` 字段。
- 为 condition/select/range_dispatch 分别建立属性对象 schema。
- 将 `component`、`index`、`block_state_property`、`target`、`source` 等字段移动到对应 property 对象中。

### 2. `minecraft:selected_item` 缺失（已完成）

手册第 11.4.7 明确列出 `minecraft:bundle/selected_item` 和 `minecraft:selected_item`。当前 `assets/linters/items.json` 只支持 `bundle/selected_item`，`src/utils/resourceReferences.ts` 也只把 `empty` 和 `bundle/selected_item` 当作无引用模型处理。

建议：

- 在 schema 中新增 `minecraft:selected_item` / `selected_item`。
- 在引用抽取逻辑中将其视为无需继续解析引用的叶子模型。

### 3. `minecraft:special.base` 必填性与手册不一致（已完成）

手册第 11.4.8 标记 `base` 为可选字段；当前 `assets/linters/items.json` 的 `specialItemModel` 要求 `["type", "base", "model"]`，会拒绝手册示例中不含 `base` 的特殊模型。

建议：

- 按手册将 `base` 改为可选。
- 如果某些特殊类型确实需要 `base`，用类型分支单独约束，而不是对全部 `minecraft:special` 强制要求。

### 4. 方块状态 `when` 数组 OR 写法未支持（已完成）

手册第 10.5.4 允许：

```json
{
  "when": [
    { "north": "true" },
    { "south": "true" }
  ]
}
```

当前 `assets/linters/blockstates.json` 将 `when` 固定为对象，虽然支持对象内 `OR`/`AND`，但不接受数组 OR 写法。

建议：

- 将 `when` 改成 `oneOf`：条件对象、条件对象数组。
- 保留 `AND`/`OR` 嵌套对象支持。
- 明确允许补充章节 S3.7 的 `!` 否定值写法，例如 `"!true|side"`。

### 5. `pack.mcmeta` 版本边界规则未严格校验（已完成）

手册补充 S11.1 写明：

- 仅支持 1.21.9+：需要 `min_format` + `max_format`，不能使用 `pack_format` / `supported_formats`。
- 仅支持 1.21.8 及更早：需要 `pack_format`。
- 跨越 1.21.8 边界：四个字段同时需要。

当前 `assets/linters/pack.mcmeta.json` 只用 `anyOf` 接受新格式或旧格式，不能表达这些跨版本组合规则，也没有校验 `min_format <= max_format`、`overlays.entries[].directory` 只能包含 `a-z0-9_-`。

建议：

- 新增自定义诊断补足 JSON Schema 无法自然表达的跨字段规则。
- 为 overlay directory 加 pattern。
- 将 scaffold 默认格式从当前 `86.2` 评估更新到手册口径 `88.0`。

### 6. `models` 覆盖范围偏窄（已完成）

手册 S14.3 的路径模式是 `assets/<namespace>/models/**/*.json`。当前插件的 schema、跳转、补全、纹理变量、资源图只注册 `models/block/**/*.json` 和 `models/item/**/*.json`。

影响：如果用户在 `models` 下使用其他子目录，插件不会提供完整校验、引用解析和变量导航。

建议：

- 至少把模型 schema 和通用模型引用能力扩展到 `**/assets/*/models/**/*.json`。
- 对 block/item 特有约束保留额外分支。

### 7. 模型 schema 与手册仍有细节差距（已完成）

当前 `assets/linters/models-block.json` 已支持对象纹理值和新版多轴旋转，这是对补充章节 S3.1 的正向覆盖。但仍有差距：

- 手册正文第 9.7 标记 `faces` 非必填；schema 要求 element 必须有 `from`、`to`、`faces`。
- 手册第 9.11 约束模型继承链最大深度 10、纹理变量引用链不能循环；当前只避免查找时死循环，不产生诊断。
- `display.translation`、`display.scale`、`uv` 等字段未按手册范围给出提示或诊断。
- 对象纹理 `sprite` 描述中说不能使用 `#` 变量，但 schema 没有限制。

建议：

- 先确定正文旧约束与补充章节新版约束的版本口径。
- 将可用 JSON Schema 表达的约束放入 schema。
- 将继承深度、变量循环、图集混用等语义检查放入自定义诊断。

### 8. 图集 source 类型缺少类型化必填约束（已完成）

手册第 8 章中每种 atlas source 都有不同必填字段：

- `directory` 需要 `source`。
- `single` 需要 `resource`。
- `filter` 需要 `pattern`。
- `unstitch` 需要 `resource` 和 `regions`。
- `paletted_permutations` 需要 `textures`、`palette_key`、`permutations`。

当前 `assets/linters/atlases.json` 的 source 是宽松对象，`type` 本身也不是 required，许多无效图集会通过校验。

建议：为 5 种 source 建立 `oneOf` 分支，并在每个分支中声明 required 字段。

### 9. `.png.mcmeta` 与手册字段存在不一致（已完成）

手册第 27 章示例使用：

- `texture.mipmaps` 为整数数组。
- `texture.darkened_cutout_mipmap`。
- `texture.alpha_cutoff_bias`。

当前 `assets/linters/png.mcmeta.json`：

- 将 `texture.mipmaps` 定义为整数。
- 支持 `mipmap_strategy`，但不支持 `darkened_cutout_mipmap`。
- 支持 `alpha_cutoff_bias`。

补充章节 S1 又使用 `mipmap_strategy`，与第 27 章存在文档口径差异。需要先确认最终目标版本字段，再更新 schema。

### 10. GUI 缩放 `.png.mcmeta` 缺少条件必填（已完成）

手册第 18.4 中，`tile` 和 `nine_slice` 需要 `width`、`height`，`nine_slice` 还需要 `border`。当前 schema 只要求 `gui.scaling.type`，不会提示这些字段缺失。

建议：按 `scaling.type` 建立 `oneOf` 分支。

### 11. 字体 provider schema 过宽（已完成）

手册第 15 章为 `bitmap`、`space`、`ttf`、`unihex`、`reference` 定义了不同字段。当前 `assets/linters/font.json` 允许宽松 provider：

- 不按 provider 类型要求 `file`、`chars`、`ascent`、`advances`、`hex_file`、`id` 等字段。
- 仍包含 `legacy_unicode`，而手册当前章节未列为现代 provider。
- 未校验 `shift` 范围、`size_overrides.left/right` 范围等。

建议：按 provider 类型拆分 schema，并将历史 provider 标记为 deprecated 或移到兼容分支。

### 12. 后处理 target 语义未诊断（已完成）

手册第 16.6 说明 `passes[].output` 是目标名称，且不能与输入相同。当前插件会解析 shader 和纹理输入，但不会：

- 检查 `output` 是否引用了已声明 target 或内置 target。
- 检查 `inputs[].target` 是否存在。
- 检查 output 与 input 相同的错误。

建议：增加 post_effect 自定义诊断。

### 13. 声音事件引用没有跨事件诊断（已完成）

当前 `resourceReferences.ts` 会跳过 `sounds[].type === "event"`，因此不会检查声音事件引用是否存在。手册第 13 章中 `type: "event"` 的 `name` 是另一个声音事件。

建议：

- 对 `type: "event"` 建立 sounds.json 内部或跨资源包事件引用诊断。
- 对声音文件名空白、`.ogg` 扩展误写、无效 volume/pitch 导致整个文件被忽略等情况给出更强提示。

### 14. 加载机制、filter、overlay 没有完整建模（已完成）

当前资源解析顺序是：当前资源根、叠加文件回退到主资源包、配置的默认原版 assets。它没有完整实现手册第 24、25、28 章：

- 不解析 `pack.mcmeta` 中 overlay 条目的版本范围和优先级。
- 不应用 `filter.block` 对低优先级资源的屏蔽效果。
- 不模拟多个启用资源包之间的加载顺序。
- 不处理语言文件、声音事件、图集来源等类型的合并/替换规则。

影响：缺失资源诊断可能把被 filter 屏蔽的下层资源当作可用资源；资源图也可能与实际游戏加载结果不一致。

建议：新增一个资源包上下文索引，读取 `pack.mcmeta`，显式建模 overlay/filter 和资源优先级。

## 低优先级或功能增强

### 15. 非 JSON 资源约束基本未校验

手册覆盖了大量非 JSON 资源规则，当前插件基本不诊断：

- `pack.png` 是否存在、是否为 PNG。
- `textures/colormap/*.png` 是否为 256x256。
- 声音文件是否为 OGG Vorbis、声道是否符合位置音效预期。
- `texts/splashes.txt` 的特殊 hash 行、文本宽度、UTF-8 规则。
- `end.txt`、`postcredits.txt` 的占位符和格式化代码。

建议：按收益逐步增加轻量诊断，避免在大资源包中做昂贵文件扫描。

### 16. 目录脚手架不完整

`src/commands/resourcePackScaffold.ts` 已创建常用目录，但手册目录树中还有一些 Java 版目录没有创建：

- `textures/colormap`
- `textures/environment`
- `textures/map`
- `textures/misc`
- `textures/mob_effect`
- `textures/painting`
- `textures/trims`
- `texts` 下的常用文本文件模板

建议：补齐目录，或提供“精简/完整”脚手架选项。

### 17. 默认资源包格式版本落后于手册口径

手册声明基于 Minecraft 26.2 / 资源包格式 88.0。当前 `src/commands/constants.ts` 的 `defaultPackAttributes.packFormat` 是 `86.2`，`pack.mcmeta` schema snippet 也默认 `[86, 2]`。

建议：如果项目目标就是跟随此手册，默认值应改为 `88.0`；如果保留旧默认值，应在 README 或设置中说明目标版本。

## 建议落地顺序

1. 先修 `items.json`：`property` 对象结构、`selected_item`、`special.base` 必填性。这是最容易造成合法文件误报的部分。
2. 修 `blockstates.json` 的 `when` 数组 OR 和 `pack.mcmeta` 的 overlay directory / 版本边界诊断。
3. 将 atlas、font、gui `.png.mcmeta` 改为按 `type` 分支的严格 schema。
4. 扩展 `models/**/*.json` 覆盖范围，同时保留 block/item 特化逻辑。
5. 引入资源包上下文索引，逐步支持 overlay/filter/加载顺序语义。
6. 最后补非 JSON 资源诊断和完整脚手架。
