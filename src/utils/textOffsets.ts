export interface TextPosition {
  line: number;
  character: number;
}

/** Maps UTF-16 text offsets to zero-based editor positions and back. */
export class TextOffsetMap {
  private readonly lineStarts: number[];

  constructor(private readonly text: string) {
    this.lineStarts = [0];
    for (let index = 0; index < text.length; index++) {
      if (text.charCodeAt(index) === 10) {
        this.lineStarts.push(index + 1);
      }
    }
  }

  offsetAt(position: TextPosition): number | null {
    if (position.line < 0 || position.line >= this.lineStarts.length || position.character < 0) {
      return null;
    }

    const lineStart = this.lineStarts[position.line];
    const lineEnd = position.line + 1 < this.lineStarts.length
      ? this.lineStarts[position.line + 1]
      : this.text.length;
    const offset = lineStart + position.character;
    return offset <= lineEnd ? offset : null;
  }

  positionAt(offset: number): TextPosition {
    const normalizedOffset = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;

    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lineStarts[middle] <= normalizedOffset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }

    return {
      line: low,
      character: normalizedOffset - this.lineStarts[low]
    };
  }
}
