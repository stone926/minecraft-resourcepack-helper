/* eslint-disable @typescript-eslint/semi */
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
const { parse } = require("@humanwhocodes/momoa");

enum CursorPos { elements, overrides, others };

/**
 * TODO 用ast解析 并写一个ast的工具库
 * ! 目前这块能用了，但是逻辑非常烂，只是凑巧能用
 */

export default (document: vscode.TextDocument, position: vscode.Position) => {
  const defaultPath = vscode.workspace.getConfiguration().get("McResHelper.defaultMcAssetsPath")
  // const blockMatch = /(.+)\\models\\(block|item).+json$/.exec(document.fileName)
  const blockMatch = /(.+)\\models\\block.+json$/.exec(document.fileName)
  if (blockMatch) {
    const word = document.getText(document.getWordRangeAtPosition(position))
    const json = document.getText()
    // textures
    if (new RegExp(`"textures"\\s*?:\\s*?\\{[\\s\\S]*?${word.replace('/', '\\/')}[\\s\\S]*?\\}`, 'gm').test(json)) {
      const name = word.startsWith('"minecraft:') ? word.slice(11, -1) : word.slice(1, -1)
      const distName = `${blockMatch[1]}/textures/${name}.png`
      if (fs.existsSync(distName)) {
        return new vscode.Location(vscode.Uri.file(distName), new vscode.Position(0, 0))
      } else if (defaultPath !== null) {
        const join = path.join(<string>defaultPath, "minecraft", `/textures/${name}.png`)
        if (fs.existsSync(join)) {
          return new vscode.Location(vscode.Uri.file(join), new vscode.Position(0, 0))
        }
      }
    }
    // parent
    if (new RegExp(`"parent"\\s*?:\\s*?[\\s\\S]*?${word.replace('/', '\\/')}[\\s\\S]*?\\}`, 'gm').test(json)) {
      const name = word.startsWith('"minecraft:') ? word.slice(11, -1) : word.slice(1, -1)
      const distName = `${blockMatch[1]}/models/${name}.json`
      if (fs.existsSync(distName)) {
        return new vscode.Location(vscode.Uri.file(distName), new vscode.Position(0, 0))
      } else if (defaultPath !== null) {
        const join = path.join(<string>defaultPath, "minecraft", `/models/${name}.json`)
        if (fs.existsSync(join)) {
          return new vscode.Location(vscode.Uri.file(join), new vscode.Position(0, 0))
        }
      }
    }
  }

  const itemMatch = /(.+)\\models\\item.+json$/.exec(document.fileName)
  if (itemMatch) {
    const word = document.getText(document.getWordRangeAtPosition(position))
    const json = document.getText()

    const line = position.line + 1;
    const character = position.character + 1;
    const ast = parse(document.getText(), { tokens: true });
    let cursorPos: CursorPos = CursorPos.others;
    for (let item of ast.body.members) {
      if (item.loc.start.line <= line && line <= item.loc.end.line) {
        if (item.name.value === 'elements' || item.name.value === 'textures') {
          cursorPos = CursorPos.elements;
          break;
        } else if (item.name.value === 'overrides') {
          cursorPos = CursorPos.overrides;
          break;
        }
      }
    }
    if (cursorPos === CursorPos.elements) {
      // textures
      if (new RegExp(`"textures"\\s*?:\\s*?\\{[\\s\\S]*?${word.replace('/', '\\/')}[\\s\\S]*?\\}`, 'gm').test(json)) {
        const name = word.startsWith('"minecraft:') ? word.slice(11, -1) : word.slice(1, -1)
        const distName = `${itemMatch[1]}/textures/${name}.png`
        if (fs.existsSync(distName)) {
          return new vscode.Location(vscode.Uri.file(distName), new vscode.Position(0, 0))
        } else if (defaultPath !== null) {
          const join = path.join(<string>defaultPath, "minecraft", `/textures/${name}.png`)
          if (fs.existsSync(join)) {
            return new vscode.Location(vscode.Uri.file(join), new vscode.Position(0, 0))
          }
        }
      }
    } else if (cursorPos === CursorPos.overrides) {
      console.log("overrieds");
    }

    // parent
    if (new RegExp(`"parent"\\s*?:\\s*?[\\s\\S]*?${word.replace('/', '\\/')}[\\s\\S]*?\\}`, 'gm').test(json)) {
      const name = word.startsWith('"minecraft:') ? word.slice(11, -1) : word.slice(1, -1)
      const distName = `${itemMatch[1]}/models/${name}.json`
      if (fs.existsSync(distName)) {
        return new vscode.Location(vscode.Uri.file(distName), new vscode.Position(0, 0))
      } else if (defaultPath !== null) {
        const join = path.join(<string>defaultPath, "minecraft", `/models/${name}.json`)
        if (fs.existsSync(join)) {
          return new vscode.Location(vscode.Uri.file(join), new vscode.Position(0, 0))
        }
      }
    }
  }

  const stateMatch = /(.+)\\blockstates.+json$/.exec(document.fileName)
  if (stateMatch) {
    const word = document.getText(document.getWordRangeAtPosition(position))
    console.log(word)
    const json = document.getText()
    if (new RegExp(`"model"\\s*?:\\s*?[\\s\\S]*?${word.replace('/', '\\/')}[\\s\\S]*?\\}`, 'gm').test(json)) {
      const name = word.startsWith('"minecraft:') ? word.slice(11, -1) : word.slice(1, -1)
      const distName = `${stateMatch[1]}/models/${name}.json`
      if (fs.existsSync(distName)) {
        return new vscode.Location(vscode.Uri.file(distName), new vscode.Position(0, 0))
      } else if (defaultPath !== null) {
        const join = path.join(<string>defaultPath, "minecraft", `/models/${name}.json`)
        if (fs.existsSync(join)) {
          return new vscode.Location(vscode.Uri.file(join), new vscode.Position(0, 0))
        }
      }
    }
  }

  const particleMatch = /(.+)\\particles.+json$/.exec(document.fileName)
  if (particleMatch) {
    const word = document.getText(document.getWordRangeAtPosition(position))
    const json = document.getText()
    if (new RegExp(`"textures"\\s*?:\\s*?\\[[\\s\\S]*?${word.replace('/', '\\/')}[\\s\\S]*?\\]`, 'gm').test(json)) {
      const name = word.startsWith('"minecraft:') ? word.slice(11, -1) : word.slice(1, -1)
      const distName = `${particleMatch[1]}/textures/particle/${name}.png`
      if (fs.existsSync(distName)) {
        return new vscode.Location(vscode.Uri.file(distName), new vscode.Position(0, 0))
      } else if (defaultPath !== null) {
        const join = path.join(<string>defaultPath, "minecraft", `/textures/particle/${name}.png`)
        if (fs.existsSync(join)) {
          return new vscode.Location(vscode.Uri.file(join), new vscode.Position(0, 0))
        }
      }
    }
  }
}