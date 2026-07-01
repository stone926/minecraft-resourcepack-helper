# Minecraft 资源包助手

[English README](README.md)

Minecraft 资源包助手是面向 Minecraft Java 版资源包作者的 VS Code 扩展。它理解现代资源包文件，在编辑时提供资源路径跳转、补全、诊断、校验和引用关系视图。

## 预览

![资源路径补全](assets/completion.gif)

![跳转定义](assets/definition.gif)

![校验诊断](assets/validitor.gif)

## 功能亮点

- 为方块状态、方块/物品模型、现代物品模型定义、粒子、纹理图集、装备、字体、路径点样式、后处理、声音、着色器导入以及 OptiFine CIT 纹理/模型路径提供跳转定义和资源路径补全。
- 缺失资源诊断会按当前资源包、已启用的资源包叠加目录、配置的低优先级资源包和原版资源路径逐级解析。
- 模型纹理变量支持：跳转到 `#texture` 定义、使用父模型继承的变量、高亮未定义变量，并提示循环变量引用或过深的父模型链。
- Minecraft 资源活动栏视图展示当前文件引用、入站引用、子模型，以及方块状态 -> 模型 -> 纹理关系。
- 为支持的资源包文件提供 JSON Schema 校验，包括资源包元数据、模型、物品定义、粒子、纹理图集、装备、字体、声音、语言文件、credits、GPU 警告列表、区域合规文件和 PNG 纹理元数据。
- 额外语义检查覆盖 `pack.mcmeta`、`pack.png`、colormap PNG 尺寸、`sounds.json`、后处理 target，以及 `assets/<namespace>/texts/{splashes,end,postcredits}.txt`。
- 扩展命令、运行时提示、诊断、资源关系图标签、模型预览问题和模型预览 webview 控件均覆盖英文与简体中文本地化。
- 提供创建现代资源包脚手架的命令，包含常用命名空间目录和 `min_format`/`max_format` 资源包元数据。

## 快速开始

1. 从 [VS Code 扩展市场](https://marketplace.visualstudio.com/items?itemName=stone926.minecraft-resourcepack-helper) 安装扩展。
2. 打开包含 Minecraft 资源包 `pack.mcmeta` 的文件夹。
3. 如需让跳转、补全、诊断和资源关系图回退到原版资源，配置 `McResHelper.defaultMcAssetsPath`。
4. 可选：用 `McResHelper.resourcePackLoadOrder` 配置低优先级资源包根目录的绝对路径。
5. 打开受支持的资源包文件，使用跳转定义、路径建议、诊断或 Minecraft 资源活动栏视图。

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
- OptiFine CIT `.properties`：纹理和模型路径跳转支持。

## 配置项

- `McResHelper.defaultMcAssetsPath`：原版 Minecraft 资源的绝对路径。可以指向 `assets` 文件夹、`assets/minecraft` 文件夹，或包含 `assets/minecraft` 的资源包根目录。
- `McResHelper.resourcePackLoadOrder`：低优先级的已启用资源包根目录的绝对路径列表。当前资源包会优先解析，该列表会在原版资源之前使用。
- `McResHelper.tipColorForUndefinedTextureVariables`：用于高亮模型文件中未定义 `#texture` 变量的颜色。

示例：

```json
{
  "McResHelper.defaultMcAssetsPath": "C:/.minecraft/26.2/assets/minecraft",
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
- `McResHelper: refresh resource graph`（刷新资源关系图）

## 开发

```bash
npm install
npm run compile
npm run lint
npm test
```

## 链接

- [VS Code 扩展市场](https://marketplace.visualstudio.com/items?itemName=stone926.minecraft-resourcepack-helper)
- [项目仓库](https://github.com/stone926/minecraft-resourcepack-helper)
