import {
  BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  FrontSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  RGBAFormat,
  SRGBColorSpace,
  Vector3
} from "three";

const MISSING_TEXTURE_SIZE = 16;
const MISSING_TEXTURE_MAGENTA = [248, 0, 248];
const MISSING_TEXTURE_BLACK = [0, 0, 0];

export function groupFacesByMaterial(meshes) {
  const groups = new Map();
  for (const mesh of meshes ?? []) {
    for (const face of mesh.faces ?? []) {
      const group = groups.get(face.materialId) ?? [];
      group.push(face);
      groups.set(face.materialId, group);
    }
  }
  return groups;
}

export function createGeometry(faces) {
  const positions = [];
  const uvs = [];
  const indices = [];

  for (const face of faces) {
    const base = positions.length / 3;
    for (const position of face.positions) {
      positions.push(position[0], position[1], position[2]);
    }
    for (const uv of face.uvs) {
      uvs.push(uv[0] / 16, uv[1] / 16);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function createMissingMaterial(displayMode) {
  if (displayMode === "wireframe") {
    return new MeshBasicMaterial({ color: 0xff00ff, wireframe: true, side: FrontSide });
  }

  return new MeshStandardMaterial({ color: 0xff00ff, roughness: 0.95, side: FrontSide });
}

export function createMissingTexture() {
  const size = MISSING_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const color = (y < size / 2) !== (x < size / 2)
        ? MISSING_TEXTURE_MAGENTA
        : MISSING_TEXTURE_BLACK;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }
  }

  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

export function paletteColor(index) {
  const colors = [0x91c4f2, 0xf2a65a, 0x7bd88f, 0xd6a3fb, 0xf26d6d, 0xf2df7e, 0x70d6d0];
  return colors[index % colors.length];
}

export function viewDirection(preset) {
  switch (preset) {
    case "front":
      return new Vector3(0, 0.15, 1).normalize();
    case "back":
      return new Vector3(0, 0.15, -1).normalize();
    case "left":
      return new Vector3(-1, 0.15, 0).normalize();
    case "right":
      return new Vector3(1, 0.15, 0).normalize();
    case "top":
      return new Vector3(0, 1, 0.001).normalize();
    case "bottom":
      return new Vector3(0, -1, 0.001).normalize();
    default:
      return new Vector3(1, 0.75, 1).normalize();
  }
}
