# RSGL - 资源包生成语言

[English README](README.md)

这是一个独立的 VS Code 扩展，用于编辑和校验 `.rsgl` 源文件，并由这些源文件构建 Minecraft Java 版资源包。

## 功能

- 为 `.rsgl` 文件提供语言注册和语法高亮。
- 由内置 RSGL 语言服务器提供补全、诊断、悬停提示、签名帮助、导航、重命名、语义高亮和格式化。
- 提供 VS Code 构建和预览命令，可处理单个文件、源目录或配置的工作区根目录。
- 另行发布 CLI 包，用于在终端中执行构建、检查、监听和项目初始化工作流。
- 支持显式模板输出方言、canonical 方块状态语法、结构化类型、类型化资源 ID、编译期集合、命名空间导入和精确的模型几何变换。

本扩展可以直接安装。Minecraft Resourcepack Helper 也将其列在扩展包中，以便一并安装；两个扩展均可单独移除和独立使用。

## 快速开始

在项目根目录创建 `rsgl.config.json`：

```json
{
  "root": "src",
  "outDir": ".generated",
  "namespace": "example",
  "target": {
    "edition": "java",
    "mc": "1.21.4"
  },
  "maxEvaluationItems": 100000,
  "maxItemModelDepth": 128
}
```

然后创建 `src/main.rsgl`：

```rsgl
namespace example

type Panel = { texture: TextureId; height: Number }

let base: Panel = {
  texture: texture_id("minecraft:block/oak_planks"),
  height: 4
}
let selected: Panel = { ...base, height: 8 }
let angles = filter([...[0, 90], ...[180, 270]], angle => angle >= 0)
let modelFor: (String) -> ModelId = name => model_id(`block/${name}`)

template panel(spec: Panel) -> model {
  parent minecraft:block/block
  textures { all: spec.texture }
  element from [0, 0, 0] to [16, spec.height, 16] {
    all texture "#all"
  }
}

model block oak_panel {
  use panel(selected)
}

blockstate variants oak_panel {
  case * => modelFor("oak_panel")
}
```

在命令面板中使用对应的 **RSGL:** 命令。若要在终端中运行相同的项目工作流，请安装下文介绍的独立版本 CLI 包。

## 显式模板方言

正文片段模板在 `->` 后声明输出方言，从而让模板中的合法语句及每个 `use` 位置都没有歧义：

- `-> model` 输出模型正文的字段和几何体。
- `-> variants` 输出 canonical 方块状态 variant 条目。
- `-> multipart` 输出 canonical 方块状态 multipart 条目。
- `-> choice` 输出一个方块状态随机 choice 内的选项。
- `-> item_model` 恰好输出一个递归物品模型节点。

不带箭头的模板仍是完整资源模板，可以包含 `model`、`blockstate` 或 `item` 等声明。

```rsgl
template horizontal(model: ModelId) -> variants {
  case { facing: north } => model
  case { facing: east } => model with { y: 90 }
  case { facing: south } => model with { y: 180 }
  case { facing: west } => model with { y: 270 }
}

template poweredOverlay(model: ModelId) -> multipart {
  part when $state.powered == true => model
}

template weatheredOptions(base: ModelId, alternate: ModelId) -> choice {
  option base weight 3
  option alternate
}

blockstate variants panel {
  use horizontal(model_id("block/panel"))
}

blockstate multipart lamp {
  part always => model_id("block/lamp")
  use poweredOverlay(model_id("block/lamp_powered"))
}

blockstate variants weathered_panel {
  case * => random {
    use weatheredOptions(
      model_id("block/weathered_panel"),
      model_id("block/weathered_panel_alt")
    )
  }
}
```

RSGL 只接受 canonical 方块状态语法：将模式直接写在 `blockstate` 之后；variants 使用 `case <selector> => <choice>`，multipart 使用 `part always => <choice>` 或 `part when <StatePredicate> => <choice>`。模型 choice 是带可选 `with { x, y, z, uvlock }` 的 `ModelId` 表达式；带权重的备选项应写在 `random { option ... }` 中。

## 递归物品模型与约定模块

物品模型构造器支持递归：`case`、`fallback`、`on_true`、`on_false`、`model`、`entry`、`frames` 以及有序的 `first_match` 分支，都可以包含另一个构造器或 `use` 一个 `-> item_model` 模板。模型叶节点接受后缀 `with { tints, transformation }` 选项。

内置的 `rsgl:conventions/item_definitions.rsgl` 模块提供可复用、数据驱动的辅助模板：

- `potionItem(id, folder, potions)` 根据调用方持有的有序表输出完整的药水物品。
- `orderedEnchantedBookItemModel(enchantments, fallbackModel) -> item_model` 同时保留附魔优先级和等级顺序。
- `tridentVariantItemModel(suffix, fallbackModel) -> item_model` 让普通、手持和投掷三种变体共用一棵附魔决策树。
- `selfMappedItems(ids)` 将调用方提供的每个物品 ID 映射到同名模型。
- `tintedSpawnEggItemModel(baseModel, baseColor, highlightColor) -> item_model` 仅在显式提供颜色时添加两个常量 tint。

```rsgl
import {
  potionItem,
  selfMappedItems,
  tintedSpawnEggItemModel
} from "rsgl:conventions/item_definitions.rsgl"

let potions = [
  { id: minecraft:mundane, stem: "mundane" },
  { id: minecraft:long_night_vision, stem: "night_vision_long" }
]

use potionItem(id: minecraft:potion, folder: "normal", potions: potions)

use selfMappedItems(ids: [
  minecraft:allay_spawn_egg,
  minecraft:armadillo_spawn_egg
])

item custom_spawn_egg {
  use tintedSpawnEggItemModel(
    baseModel: minecraft:item/custom_spawn_egg,
    baseColor: -6265536,
    highlightColor: [1, 0.5, 0]
  )
}
```

这些约定模块刻意不包含药水、通用附魔或刷怪蛋注册表。请将这些列表保留在项目源码中，使其别名、顺序和 Minecraft 版本绑定保持显式可见。

## 类型、函数、ID 与集合

RSGL 在编译期执行抽象逻辑。类型别名和结构化记录类型能够发现缺失、多余和类型不兼容的字段。可选记录字段使用 `?`；函数值使用 `(ParameterTypes) -> ReturnType` 标注和 lambda 表达式。

资源引用具有不同的 `ResourceId`、`ModelId`、`TextureId` 和 `TextureRef` 类型。当上下文无法选择预期类型，或需要显式收窄普通字符串时，使用 `resource_id(...)`、`model_id(...)` 或 `texture_id(...)`。

集合操作包括 `map`、`filter`、`flatMap`、`concat`、`join`、`entries`、`keys`、`values`、`mergeObjects` 和 `has`。列表和对象支持 spread 元素：

```rsgl
type Material = { texture: TextureId; tint?: Number }

let names = concat(["oak"], ["spruce", "birch"])
let textures: List<TextureId> = map(names, name => texture_id(`block/${name}_planks`))
let visible = filter(textures, texture => texture != texture_id("block/birch_planks"))
let defaults: Material = { texture: textures[0] }
let material: Material = { ...defaults, ...{ tint: 0 } }
let fields = keys(material)
```

集合展开受 `maxEvaluationItems` 限制，因此格式错误或异常庞大的源码不会无限增长。
展开后的递归物品模型另由 `maxItemModelDepth` 独立限制，其深度按从深度 0 的根节点起经过的边数计算。

## 命名空间导入

当模块导出多个相关的值或模板时，可以使用命名空间导入。成员保持限定名称，从而避免冲突并明确其来源。

`src/common.rsgl`：

```rsgl
let OAK: TextureId = texture_id("minecraft:block/oak_planks")

template cube(texture: TextureId) -> model {
  parent minecraft:block/cube_all
  textures { all: texture }
}

export { OAK, cube }
```

`src/main.rsgl`：

```rsgl
import * as common from "./common.rsgl"

model block oak_cube {
  use common.cube(common.OAK)
}
```

同时支持具名导入和裸副作用导入。只有显式导出的名称才能导入。不支持默认导入；请改用具名导入或命名空间导入。

## 模型几何变换

`transform` 围绕显式 pivot 执行精确的轴对齐四分之一圈旋转，并将其应用到所有嵌套的模型几何语句。编译器会校验操作、编译期角度、pivot 和变换后的几何体，而不是依赖浮点近似。

```rsgl
template rotatedPost(texture: TextureId) -> model {
  textures { post: texture }
  transform rotate_y(90) around [8, 8, 8] {
    element from [6, 0, 1] to [10, 16, 5] {
      all texture "#post"
    }
  }
}

model block rotated_post {
  use rotatedPost(texture_id("minecraft:block/oak_log"))
}
```

支持的操作包括 `rotate_x`、`rotate_y` 和 `rotate_z`。可以嵌套 transform 来组合多个精确旋转。

## 项目配置

将 `rsgl.config.json` 放在项目目录或其任一上级目录中。扩展会为所有受支持的设置提供校验和补全。

- `root` 选择相对于配置文件的源文件或目录。
- `outDir` 选择生成内容的输出目录。
- `namespace` 是项目默认值，而非强制覆盖。优先级依次为：显式编译器/API 覆盖、源码中的 `namespace` 声明、项目设置，最后是 `minecraft`。
- `target` 是项目级 Java 版约束。必须且只能设置 `format`（例如 `[50, 0]`）或 `mc`（例如 `"1.21.4"`）之一。允许源码中存在匹配的 target；冲突的 target 会产生诊断。
- `maxEvaluationItems` 是编译期集合有界展开的正数预算，默认为 `100000`，并参与编译器缓存标识。
- `maxItemModelDepth` 是展开后物品模型的正数递归上限，按从深度 0 的根节点起经过的边数计算，默认为 `128`，并参与编译器缓存标识。
- `emitSourceMap`、`manifest`、`defaultAssetsPath`、`resourcePackRoots`、`extern` 和 `checkExternExistence` 控制生成的元数据及外部资源校验。

命令行 `--out` 会覆盖 build、check 和 watch 操作的 `outDir`，但不会更改配置文件。

## CLI

CLI 不内置于 VS Code 扩展中。请使用 Node.js 20 或更高版本安装独立发布的 npm 包：

```bash
npm install --global @minecraft-resourcepack-helper/rsgl-cli
```

完整命令范围如下：

```text
rsgl init
rsgl build [root|file] [--out <dir>] [--preview] [--watch]
rsgl check [root|file] [--out <dir>]
rsgl watch [root|file] [--out <dir>]
```

`--preview` 仅适用于 build；`--watch` 是与 `watch` 命令等价的 build 快捷方式。
