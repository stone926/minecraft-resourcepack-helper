# Minecraft 资源包助手

[English README](README.md)

Minecraft 资源包助手是面向 Minecraft Java 版资源包作者的 VS Code 扩展。它理解现代资源包结构，在编辑时提供资源路径跳转、补全、诊断、JSON 校验、模型预览和引用关系视图。

## 预览

![资源路径补全](assets/completion.gif)

![跳转定义](assets/definition.gif)

![校验诊断](assets/validitor.gif)

## 功能亮点

- 为方块状态、方块/物品模型、现代物品模型定义、粒子、纹理图集、装备、字体、路径点样式、后处理、声音和着色器导入提供跳转定义和资源路径补全。
- 为 CIT `.properties` 中的纹理和模型路径提供跳转定义、补全、缺失资源诊断和资源关系图支持。
- 缺失资源诊断会按当前资源包、资源包 overlays 和 filters、配置的低优先级资源包、原版资源逐级解析。
- 模型纹理变量支持：跳转到 `#texture` 定义、追踪父模型继承的变量、高亮未定义变量，并提示循环变量引用或过深的父模型链。
- Minecraft 资源活动栏视图展示当前文件引用、入站引用、模型继承、子模型，以及方块状态 -> 模型 -> 纹理关系。
- 为模型 JSON 提供 Three.js 模型预览，支持纹理/实体/线框显示模式、相机视角、透视/正交相机、网格与坐标轴开关、问题/依赖面板、实时刷新和 PNG 导出。
- 为支持的资源包文件提供 JSON Schema 校验，包括资源包元数据、模型、物品定义、粒子、纹理图集、装备、字体、声音、语言文件、credits、GPU 警告列表、区域合规文件和 PNG 纹理元数据。
- 额外语义检查覆盖 `pack.mcmeta`、`pack.png`、colormap PNG 尺寸、`sounds.json`、后处理 target、模型 parent/纹理变量链，以及 `assets/<namespace>/texts/{splashes,end,postcredits}.txt`。
- 扩展命令、运行时提示、诊断、资源关系图标签、模型预览问题和模型预览 webview 控件均覆盖英文与简体中文本地化。
- 提供创建现代资源包脚手架的命令，包含常用命名空间目录、默认 `pack.png` 和 `min_format`/`max_format` 资源包元数据。

## 快速开始

1. 从 [VS Code 扩展市场](https://marketplace.visualstudio.com/items?itemName=stone926.minecraft-resourcepack-helper) 安装扩展。
2. 打开包含 Minecraft 资源包 `pack.mcmeta` 的文件夹。
3. 如需让跳转、补全、诊断、资源关系图和模型预览回退到原版资源，配置 `McResHelper.defaultMcAssetsPath`。
4. 可选：用 `McResHelper.resourcePackLoadOrder` 配置低优先级资源包根目录的绝对路径。
5. 打开受支持的资源包文件，使用跳转定义、路径建议、诊断、Minecraft 资源活动栏视图，或在模型 JSON 中打开模型预览。

当工作区中存在 `pack.mcmeta` 时，扩展会自动激活。

## 资源解析顺序

跳转、补全、诊断、资源关系图和模型预览会尽量使用同一套加载顺序：

1. 当前正在编辑的资源包。
2. `pack.mcmeta` 中声明的启用 overlay 和 filter 规则。
3. `McResHelper.resourcePackLoadOrder` 中配置的低优先级资源包，按高优先级到低优先级排序。
4. `McResHelper.defaultMcAssetsPath` 指向的原版资源。

## 模型预览

在模型 JSON 编辑器中，可以通过 **McResHelper: 打开模型预览** 命令、编辑器标题/右键菜单，或 Minecraft 资源视图中的模型节点打开预览。

预览会解析父模型、纹理、纹理变量、`.png.mcmeta` 纹理元数据、配置的资源包加载顺序和原版资源。它在 VS Code webview 中渲染方块模型和 generated 物品模型，并在相关模型、纹理、元数据、当前编辑器或配置变化后自动刷新。

预览控件包括：

- 视角预设：3/4、前、后、左、右、顶部和底部。
- 透视相机与正交相机。
- 纹理、实体和线框显示模式。
- 网格和坐标轴显示开关。
- 可点击的问题与依赖列表，用于跳转到相关文件或配置。
- PNG 导出，可自定义宽高，选择透明背景或指定背景色。

当前范围：模型预览支持 Minecraft 模型 JSON 资源和 CIT `.properties` 资源预览。部分视觉效果会使用近似处理，包括无法解码纹理像素时的 generated 物品侧面挤出、动画纹理只显示已加载 PNG 的第一帧，以及元素 rotation `rescale`。

CIT `.properties` 预览是资源预览，不是完整 CIT 运行态模拟。它会尽量解析主 `model` 或 `texture` 并渲染对应模型/纹理，但不会完整执行所有匹配分支或渲染层行为。尤其是 `texture.*`、`tile.*`、`model.*` 状态变体、物品条件匹配、附魔 glint 层、blend 行为以及盔甲/equipment layer 选择，可能与游戏中的 CIT Resewn 结果不同。

## 支持的引用

- `assets/<namespace>/blockstates/**/*.json`：variants 和 multipart 中的模型引用。
- `assets/<namespace>/models/**/*.json`：父模型引用、纹理引用和纹理变量。
- `assets/<namespace>/items/**/*.json`：现代物品模型定义、嵌套模型、特殊模型 base 和受支持的特殊纹理。
- `assets/<namespace>/particles/**/*.json`：粒子纹理引用。
- `assets/<namespace>/atlases/**/*.json`：纹理图集中的纹理和纹理目录引用。
- `assets/<namespace>/equipment/**/*.json`：装备层纹理引用。
- `assets/<namespace>/font/**/*.json`：字体引用，以及 bitmap、TTF、Unihex provider 文件。
- `assets/<namespace>/waypoint_style/**/*.json`：定位栏精灵纹理。
- `assets/<namespace>/post_effect/**/*.json`：后处理着色器引用和 effect 纹理。
- `assets/<namespace>/sounds.json`：声音文件引用和声音事件检查。
- `assets/<namespace>/shaders/{core,post}/**/*.{vsh,fsh}`：`#moj_import` 着色器 include 引用。
- CIT `.properties`：纹理和模型路径跳转、补全、缺失资源诊断和资源关系图支持。

## 诊断与校验

扩展会把 VS Code JSON Schema 与资源感知诊断结合使用。

- 缺失资源警告使用与跳转和补全相同的解析规则。
- `pack.mcmeta` 检查覆盖现代 `min_format`/`max_format` 用法、旧版 `pack_format`，以及跨越 1.21.8 资源包格式边界的配置。
- 非 JSON 检查覆盖缺失或无效的 `pack.png`、无效或尺寸不正确的 colormap PNG，以及 `splashes.txt`、`end.txt`、`postcredits.txt` 中的 UTF-8 或格式问题。
- `sounds.json` 检查覆盖声音文件引用、声音文件名空白字符、多余 `.ogg` 扩展名、无效数值字段，以及未定义的声音事件引用。
- `post_effect` 检查 target/pass 之间的引用关系。
- 模型检查覆盖 parent 链深度、parent 循环、缺失纹理、缺失纹理变量和纹理变量循环链。

## 资源关系图

**Minecraft 资源**活动栏视图会跟随当前编辑器，展示当前资源周围的引用关系。

- 当前文件：当前资源本身。
- 引用了谁：当前资源指向的模型、纹理、着色器、字体、声音和纹理目录引用。
- 被谁引用：工作区中指向当前资源的入站引用。
- 模型继承树：父模型和子模型。
- 方块：工作区中的方块状态文件，可作为方块状态 -> 模型 -> 纹理链路的入口。

该视图使用缓存的工作区索引，也可以通过 **McResHelper: 刷新资源映射** 手动刷新。

## 配置项

- `McResHelper.defaultMcAssetsPath`：原版 Minecraft 资源的绝对路径。可以指向 `assets` 文件夹、`assets/minecraft` 文件夹，或包含 `assets/minecraft` 的资源包根目录。
- `McResHelper.resourcePackLoadOrder`：当前编辑资源包下层已启用资源包根目录的绝对路径列表，按高优先级到低优先级排序。解析时会先查当前资源包，再查该列表，最后查原版资源。
- `McResHelper.tipColorForUndefinedTextureVariables`：用于高亮模型文件中未定义 `#texture` 变量的颜色。

示例：

```json
{
  "McResHelper.defaultMcAssetsPath": "C:/.minecraft/my_test/26.2/assets/minecraft",
  "McResHelper.resourcePackLoadOrder": [
    "C:/.minecraft/resourcepacks/base_pack"
  ],
  "McResHelper.tipColorForUndefinedTextureVariables": "Chartreuse"
}
```

## 命令

- `McResHelper: open folder of vanilla assets`（打开原版资源文件夹）
- `McResHelper: create a new pack in current folder`（在当前文件夹创建新资源包）
- `McResHelper: create a new pack with the current folder as the root directory`（以当前文件夹为根目录创建新资源包）
- `McResHelper: refresh resource graph`（刷新资源映射）
- `McResHelper: open model preview`（打开模型预览）
- `McResHelper: export model preview image`（导出模型预览图片）
- `McResHelper: open model preview from resource graph`（从资源图打开模型预览）

模型预览命令也会出现在模型 JSON 的编辑器菜单中。资源关系图里的模型节点提供内联预览操作。

## 脚手架

资源包创建命令会依次询问资源包名称、命名空间、目标资源包格式版本和描述。生成内容包括 `pack.mcmeta`、默认 `pack.png`，以及 `blockstates`、`models`、`items`、`textures`、`sounds`、`font`、`atlases`、`equipment`、`post_effect`、`shaders`、`waypoint_style` 等常用命名空间目录。

## 开发

```bash
npm install
npm run compile
npm run lint
npm test
```

常用专项命令：

```bash
npm run benchmark:model-preview
npm run package:vsix
```

## 链接

- [VS Code 扩展市场](https://marketplace.visualstudio.com/items?itemName=stone926.minecraft-resourcepack-helper)
- [项目仓库](https://github.com/stone926/minecraft-resourcepack-helper)
