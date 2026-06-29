import type { PreviewDirection } from "../ir/PreviewDocument";

export type UvRect = [number, number, number, number];

export function getDefaultUv(direction: PreviewDirection, from: [number, number, number], to: [number, number, number]): UvRect {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;

  switch (direction) {
    case "down":
      return [x1, 16 - z2, x2, 16 - z1];
    case "up":
      return [x1, z1, x2, z2];
    case "north":
      return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
    case "south":
      return [x1, 16 - y2, x2, 16 - y1];
    case "west":
      return [z1, 16 - y2, z2, 16 - y1];
    case "east":
      return [16 - z2, 16 - y2, 16 - z1, 16 - y1];
  }
}

export function getFaceUvs(rect: UvRect, rotation = 0): Array<[number, number]> {
  const [u1, v1, u2, v2] = rect;
  const uvs: Array<[number, number]> = [
    [u1, v2],
    [u1, v1],
    [u2, v1],
    [u2, v2]
  ];
  const turns = ((((rotation % 360) + 360) % 360) / 90) | 0;

  for (let index = 0; index < turns; index++) {
    uvs.unshift(uvs.pop() ?? uvs[0]);
  }

  return uvs;
}
