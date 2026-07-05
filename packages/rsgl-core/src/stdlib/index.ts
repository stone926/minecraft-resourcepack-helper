import * as fs from "node:fs";
import * as path from "node:path";
import { ExportDeclNode, ImportDeclNode, parseRsgl, RsglModule } from "../parser";
import { RsglSourceFile } from "../semantic";

export const rsglStdlibScheme = "rsgl:";
export const rsglStdlibVirtualRoot = "<rsgl-stdlib>";
export const rsglStdlibOverrideDirectory = "rsgl-std";

const stdlibSources = new Map<string, string>([
  ["constants.rsgl", [
    "let HORIZONTAL = [north, east, south, west]",
    "let DIRECTIONS = [down, up, north, south, west, east]",
    "let STAIR_SHAPES = [straight, inner_left, inner_right, outer_left, outer_right]",
    "let COLORS_16 = [white, orange, magenta, light_blue, yellow, lime, pink, gray, light_gray, cyan, purple, blue, brown, green, red, black]",
    "export { HORIZONTAL, DIRECTIONS, STAIR_SHAPES, COLORS_16 }"
  ].join("\n")],
  ["blockstates/stairs.rsgl", [
    "template stairs(base: ModelId, inner: ModelId, outer: ModelId, uvlock: Boolean = false) {",
    "  variants {",
    "    for half in [bottom, top] {",
    "      for shape in STAIR_SHAPES {",
    "        for facing in HORIZONTAL {",
    "          let model = match shape {",
    "            inner_left | inner_right -> inner",
    "            outer_left | outer_right -> outer",
    "            _ -> base",
    "          }",
    "          let x = half == top ? 180 : 0",
    "          let y = match `${half}:${shape}:${facing}` {",
    "            \"bottom:straight:north\" | \"bottom:inner_right:north\" | \"bottom:outer_right:north\" | \"top:straight:north\" | \"top:inner_left:north\" | \"top:outer_left:north\" -> 270",
    "            \"bottom:straight:south\" | \"bottom:inner_right:south\" | \"bottom:outer_right:south\" | \"top:straight:south\" | \"top:inner_left:south\" | \"top:outer_left:south\" -> 90",
    "            \"bottom:straight:west\" | \"bottom:inner_right:west\" | \"bottom:outer_right:west\" | \"top:straight:west\" | \"top:inner_left:west\" | \"top:outer_left:west\" -> 180",
    "            \"bottom:inner_left:north\" | \"bottom:outer_left:north\" | \"top:inner_right:south\" | \"top:outer_right:south\" -> 180",
    "            \"bottom:inner_left:east\" | \"bottom:outer_left:east\" | \"top:inner_right:west\" | \"top:outer_right:west\" -> 270",
    "            \"bottom:inner_left:west\" | \"bottom:outer_left:west\" | \"top:inner_right:east\" | \"top:outer_right:east\" -> 90",
    "            _ -> 0",
    "          }",
    "          [facing=facing half=half shape=shape] -> @model x=x y=y uvlock=(uvlock || x != 0 || y != 0)",
    "        }",
    "      }",
    "    }",
    "  }",
    "}",
    "export { stairs }"
  ].join("\n")],
  ["blockstates/slab.rsgl", [
    "template slab(bottom: ModelId, top: ModelId, double: ModelId) {",
    "  variants {",
    "    [type=\"bottom\"] -> @bottom",
    "    [type=\"top\"] -> @top",
    "    [type=\"double\"] -> @double",
    "  }",
    "}",
    "export { slab }"
  ].join("\n")],
  ["blockstates/fence.rsgl", [
    "template fence(post: ModelId, side: ModelId) {",
    "  multipart {",
    "    apply @post",
    "    for facing in HORIZONTAL {",
    "      let y = yaw(facing)",
    "      when { [facing]: true } apply @side y=y uvlock=(y != 0)",
    "    }",
    "  }",
    "}",
    "export { fence }"
  ].join("\n")],
  ["blockstates/fence_gate.rsgl", [
    "template fenceGate(base: ModelId, open: ModelId, wall: ModelId, wallOpen: ModelId) {",
    "  variants {",
    "    for facing in HORIZONTAL {",
    "      for inWall in [false, true] {",
    "        for isOpen in [false, true] {",
    "          let model = inWall ? (isOpen ? wallOpen : wall) : (isOpen ? open : base)",
    "          let y = match facing { north -> 180 east -> 270 west -> 90 _ -> 0 }",
    "          [facing=facing in_wall=inWall \"open\"=isOpen] -> @model y=y uvlock=true",
    "        }",
    "      }",
    "    }",
    "  }",
    "}",
    "export { fenceGate }"
  ].join("\n")],
  ["blockstates/door.rsgl", [
    "template door(bottomLeft: ModelId, bottomLeftOpen: ModelId, bottomRight: ModelId, bottomRightOpen: ModelId, topLeft: ModelId, topLeftOpen: ModelId, topRight: ModelId, topRightOpen: ModelId) {",
    "  variants {",
    "    for facing in HORIZONTAL {",
    "      for half in [lower, upper] {",
    "        for hinge in [left, right] {",
    "          for open in [false, true] {",
    "            let model = match `${half}:${hinge}:${open}` {",
    "              \"lower:left:false\" -> bottomLeft",
    "              \"lower:left:true\" -> bottomLeftOpen",
    "              \"lower:right:false\" -> bottomRight",
    "              \"lower:right:true\" -> bottomRightOpen",
    "              \"upper:left:false\" -> topLeft",
    "              \"upper:left:true\" -> topLeftOpen",
    "              \"upper:right:false\" -> topRight",
    "              _ -> topRightOpen",
    "            }",
    "            let y = match `${facing}:${hinge}:${open}` {",
    "              \"north:left:false\" | \"north:right:false\" | \"east:right:true\" -> 270",
    "              \"south:left:false\" | \"south:right:false\" | \"east:left:true\" | \"west:right:true\" -> 90",
    "              \"west:left:false\" | \"west:right:false\" | \"north:right:true\" | \"south:left:true\" -> 180",
    "              _ -> 0",
    "            }",
    "            [facing=facing half=half hinge=hinge open=open] -> @model y=y",
    "          }",
    "        }",
    "      }",
    "    }",
    "  }",
    "}",
    "export { door }"
  ].join("\n")],
  ["blockstates/trapdoor.rsgl", [
    "template trapdoor(bottom: ModelId, top: ModelId, open: ModelId) {",
    "  variants {",
    "    for facing in HORIZONTAL {",
    "      for half in [\"bottom\", \"top\"] {",
    "        for isOpen in [false, true] {",
    "          let model = isOpen ? open : (half == \"top\" ? top : bottom)",
    "          let x = isOpen && half == \"top\" ? 180 : 0",
    "          let y = match `${facing}:${half}:${isOpen}` {",
    "            \"east:bottom:false\" | \"east:top:false\" | \"west:top:true\" -> 90",
    "            \"south:bottom:false\" | \"south:top:false\" | \"north:top:true\" -> 180",
    "            \"west:bottom:false\" | \"west:top:false\" | \"east:top:true\" -> 270",
    "            _ -> 0",
    "          }",
    "          [facing=facing half=half \"open\"=isOpen] -> @model x=x y=y",
    "        }",
    "      }",
    "    }",
    "  }",
    "}",
    "export { trapdoor }"
  ].join("\n")],
  ["blockstates/wall.rsgl", [
    "template wall(post: ModelId, side: ModelId, sideTall: ModelId) {",
    "  multipart {",
    "    when { up: true } apply @post",
    "    for facing in HORIZONTAL {",
    "      for height in [low, tall] {",
    "        let model = height == tall ? sideTall : side",
    "        let y = yaw(facing)",
    "        when { [facing]: height } apply @model y=y uvlock=(y != 0)",
    "      }",
    "    }",
    "  }",
    "}",
    "export { wall }"
  ].join("\n")],
  ["blockstates/pane.rsgl", [
    "template pane(post: ModelId, side: ModelId, sideAlt: ModelId, noSide: ModelId, noSideAlt: ModelId) {",
    "  multipart {",
    "    apply @post",
    "    when { north: true } apply @side",
    "    when { east: true } apply @side y=90",
    "    when { south: true } apply @sideAlt",
    "    when { west: true } apply @sideAlt y=90",
    "    when { north: false } apply @noSide",
    "    when { east: false } apply @noSideAlt",
    "    when { south: false } apply @noSideAlt y=90",
    "    when { west: false } apply @noSide y=270",
    "  }",
    "}",
    "export { pane }"
  ].join("\n")]
]);

const preludeModulePaths = [
  "blockstates/stairs.rsgl",
  "blockstates/slab.rsgl",
  "blockstates/fence.rsgl",
  "blockstates/fence_gate.rsgl",
  "blockstates/door.rsgl",
  "blockstates/trapdoor.rsgl",
  "blockstates/wall.rsgl",
  "blockstates/pane.rsgl"
];

export function isRsglStdlibImportSource(source: string): boolean {
  return source.startsWith(rsglStdlibScheme);
}

export function normalizeRsglStdlibModulePath(source: string): string | null {
  const raw = isRsglStdlibImportSource(source) ? source.slice(rsglStdlibScheme.length) : source;
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    return null;
  }
  return normalized.endsWith(".rsgl") ? normalized : `${normalized}.rsgl`;
}

export function rsglStdlibVirtualFileName(source: string): string | null {
  const modulePath = normalizeRsglStdlibModulePath(source);
  return modulePath ? path.join(rsglStdlibVirtualRoot, modulePath) : null;
}

export function isRsglStdlibVirtualFileName(fileName: string): boolean {
  return path.normalize(fileName).startsWith(path.normalize(rsglStdlibVirtualRoot + path.sep));
}

export function readRsglStdlibSource(source: string): string | null {
  const modulePath = normalizeRsglStdlibModulePath(source);
  return modulePath ? stdlibSources.get(modulePath) ?? null : null;
}

export function createRsglStdlibSourceFile(source: string): RsglSourceFile | null {
  const fileName = rsglStdlibVirtualFileName(source);
  const text = readRsglStdlibSource(source);
  return fileName && text !== null ? { fileName, module: parseRsgl(text) } : null;
}

export function createAllRsglStdlibSourceFiles(): RsglSourceFile[] {
  return Array.from(stdlibSources.keys())
    .map(source => createRsglStdlibSourceFile(source))
    .filter((file): file is RsglSourceFile => Boolean(file));
}

export function createRsglStdlibPreludeSourceFiles(fromFileName?: string): RsglSourceFile[] {
  return preludeModulePaths
    .map(source => createRsglStdlibPreludeSourceFile(source, fromFileName))
    .filter((file): file is RsglSourceFile => Boolean(file));
}

function createRsglStdlibPreludeSourceFile(source: string, fromFileName: string | undefined): RsglSourceFile | null {
  const override = fromFileName ? resolveRsglStdlibOverrideFromDisk(fromFileName, source) : null;
  if (override) {
    try {
      return { fileName: path.normalize(override), module: parseRsgl(fs.readFileSync(override, "utf8")) };
    } catch {
      return null;
    }
  }
  return createRsglStdlibSourceFile(source);
}

export function readRsglStdlibVirtualSource(fileName: string): string | null {
  if (!isRsglStdlibVirtualFileName(fileName)) {
    return null;
  }
  const relative = path.relative(rsglStdlibVirtualRoot, fileName).replace(/\\/g, "/");
  return readRsglStdlibSource(relative);
}

export function resolveRsglStdlibOverrideFromDisk(fromFileName: string, source: string): string | null {
  const modulePath = normalizeRsglStdlibModulePath(source);
  if (!modulePath || isRsglStdlibVirtualFileName(fromFileName)) {
    return null;
  }

  let directory = path.dirname(path.resolve(fromFileName));
  while (true) {
    const candidate = path.join(directory, rsglStdlibOverrideDirectory, ...modulePath.split("/"));
    try {
      if (fs.statSync(candidate).isFile()) {
        return path.normalize(candidate);
      }
    } catch {
      // Keep walking parent directories.
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

export function resolveRsglStdlibOverrideFromFiles(source: string, fileNames: readonly string[]): string | null {
  const modulePath = normalizeRsglStdlibModulePath(source);
  if (!modulePath) {
    return null;
  }
  const suffix = path.join(rsglStdlibOverrideDirectory, ...modulePath.split("/")).toLowerCase();
  return fileNames.find(fileName => path.normalize(fileName).toLowerCase().endsWith(suffix)) ?? null;
}

export function includeRsglStdlibSourceFiles(files: readonly RsglSourceFile[]): RsglSourceFile[] {
  const result = [...files];
  const known = new Set(result.map(file => path.normalize(file.fileName)));

  for (let index = 0; index < result.length; index++) {
    const file = result[index];
    for (const source of collectRsglStdlibImports(file.module)) {
      if (resolveRsglStdlibOverrideFromFiles(source, result.map(item => item.fileName))) {
        continue;
      }
      const sourceFile = createRsglStdlibSourceFile(source);
      if (!sourceFile) {
        continue;
      }
      const normalized = path.normalize(sourceFile.fileName);
      if (!known.has(normalized)) {
        known.add(normalized);
        result.push(sourceFile);
      }
    }
  }

  return result;
}

export function collectRsglStdlibImports(module: RsglModule): string[] {
  return module.statements
    .filter((statement): statement is ImportDeclNode | ExportDeclNode => statement.kind === "ImportDecl" || statement.kind === "ExportDecl")
    .map(statement => statement.source?.value)
    .filter((source): source is string => Boolean(source && isRsglStdlibImportSource(source)));
}
