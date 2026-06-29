import type { RawElement } from "../model/ModelDocument";

export function createGeneratedItemElements(): RawElement[] {
  return [
    {
      from: [0, 0, 7.5],
      to: [16, 16, 8.5],
      shade: false,
      faces: {
        north: { texture: "#layer0", uv: [0, 0, 16, 16] },
        south: { texture: "#layer0", uv: [0, 0, 16, 16] },
        west: { texture: "#layer0", uv: [7.5, 0, 8.5, 16] },
        east: { texture: "#layer0", uv: [7.5, 0, 8.5, 16] },
        up: { texture: "#layer0", uv: [0, 7.5, 16, 8.5] },
        down: { texture: "#layer0", uv: [0, 7.5, 16, 8.5] }
      }
    }
  ];
}
