# Minecraft 资源包助手

Minecraft 资源包助手帮助 Minecraft 资源包作者在 VS Code 中处理基于 JSON 的资源包文件。

## 功能特性

- **跳转定义**：支持方块状态模型、模型父级、模型纹理、粒子纹理、物品模型定义、特殊物品模型纹理、纹理图集、装备、字体、路径点样式、后处理着色器、声音以及 OptiFine CIT 纹理/模型路径的跳转定义。
- **资源路径补全**：支持方块状态、方块/物品模型、粒子、物品模型定义、特殊物品模型纹理、纹理图集、装备、字体、路径点样式、后处理着色器和声音的路径补全。
- **缺失资源诊断**：通过 `McResHelper.defaultMcAssetsPath` 配置支持回退机制的缺失资源诊断。
- **纹理变量导航**：在模型文件中支持纹理变量导航和未定义变量高亮，包括通过父模型继承的变量。
- **Minecraft 资源侧边栏**：显示当前文件引用关系以及方块状态 -> 模型 -> 纹理的关联关系。
- **JSON 验证**：支持的资源包文件类型的 JSON 验证，包括现代 JSON 文件和 PNG 纹理元数据。
- **命令**：提供创建资源包脚手架的命令。

## 配置项

- `McResHelper.defaultMcAssetsPath`：原版 Minecraft 资源的绝对路径。该路径可以指向 `assets` 文件夹、`assets/minecraft` 文件夹，或包含 `assets/minecraft` 的资源包根目录。
- `McResHelper.tipColorForUndefinedTextureVariables`：用于在模型文件中高亮未定义的 `#texture` 变量的颜色。

## 命令

- `McResHelper: open folder of vanilla assets`（打开原版资源文件夹）
- `McResHelper: create a new pack in current folder`（在当前文件夹创建新资源包）
- `McResHelper: create a new pack with the current folder as the root directory`（以当前文件夹为根目录创建新资源包）
- `McResHelper: refresh resource graph`（刷新资源关系图）

## 安装

你可以从 [VS Code 扩展市场](https://marketplace.visualstudio.com/items?itemName=stone926.minecraft-resourcepack-helper) 安装此扩展。

## 项目仓库

[https://github.com/stone926/minecraft-resourcepack-helper](https://github.com/stone926/minecraft-resourcepack-helper)
