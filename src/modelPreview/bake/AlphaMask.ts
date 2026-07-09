export interface PngAlphaMask {
  width: number;
  height: number;
  isOpaque(x: number, y: number): boolean;
}
