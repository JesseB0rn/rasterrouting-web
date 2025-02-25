interface HF2Header {
  width: number;
  height: number;
  tileSize: number;
  vertPrecision: number;
  horizScale: number;
  extHeaderLength: number;
}

interface HF2ExtendedHeaderBlock {
  blockType: string;
  blockName: string;
  blockData: Uint8Array;
}

export class HF2Parser {
  view: DataView;
  offset: number;
  bufferLength: number;

  constructor(arrayBuffer: ArrayBuffer) {
    this.view = new DataView(arrayBuffer);
    this.offset = 0;
    this.bufferLength = arrayBuffer.byteLength;
  }

  checkBounds(size: number) {
    if (this.offset + size > this.bufferLength) {
      throw new Error("Unexpected end of file or malformed data");
    }
  }

  readUInt32() {
    this.checkBounds(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readUInt16() {
    this.checkBounds(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readFloat32() {
    this.checkBounds(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readString(length: number) {
    this.checkBounds(length);
    const bytes = new Uint8Array(this.view.buffer, this.offset, length);
    const str = new TextDecoder().decode(bytes);
    this.offset += length;
    return str.replace(/\0/g, ""); // Strip null terminators
  }

  readHeader(): HF2Header {
    const fileId = this.readString(4);
    if (fileId !== "HF2") throw new Error("Invalid HF2 file ID");

    const version = this.readUInt16();
    if (version !== 0) throw new Error("Unsupported HF2 version");

    const width = this.readUInt32();
    const height = this.readUInt32();
    const tileSize = this.readUInt16();
    const vertPrecision = this.readFloat32();
    const horizScale = this.readFloat32();
    const extHeaderLength = this.readUInt32();

    return {
      width,
      height,
      tileSize,
      vertPrecision,
      horizScale,
      extHeaderLength,
    };
  }

  readExtendedHeader(length: number): HF2ExtendedHeaderBlock[] {
    const extendedHeader = [];

    const end = this.offset + length;
    if (end > this.bufferLength) {
      throw new Error("Extended header length exceeds file size");
    }

    while (this.offset < end) {
      if (this.offset + 24 > end) {
        throw new Error("Malformed extended header block");
      }

      const blockType = this.readString(4);
      const blockName = this.readString(16);
      const blockLength = this.readUInt32();

      if (this.offset + blockLength > end) {
        throw new Error("Extended header block length exceeds available data");
      }

      const blockData = new Uint8Array(this.view.buffer, this.offset, blockLength);
      this.offset += blockLength;

      extendedHeader.push({ blockType, blockName, blockData });
    }

    return extendedHeader;
  }

  readTile(tileSize: number, remainingWidth: number, remainingHeight: number) {
    this.checkBounds(8); // Tile header
    const vertScale = this.readFloat32();
    const vertOffset = this.readFloat32();
    const tileData = [];

    const rows = Math.min(tileSize, remainingHeight);
    const cols = Math.min(tileSize, remainingWidth);

    for (let row = 0; row < rows; row++) {
      if (this.offset >= this.bufferLength) break;

      this.checkBounds(5); // Line header
      const byteDepth = this.view.getUint8(this.offset++);
      const startValue = this.view.getInt32(this.offset, true);
      this.offset += 4;

      let lastValue = startValue;
      const rowValues = [startValue];

      const valueCount = cols - 1; // Only read actual columns in this row
      for (let i = 0; i < valueCount; i++) {
        let diff;
        if (byteDepth === 1) {
          this.checkBounds(1);
          diff = this.view.getInt8(this.offset++);
        } else if (byteDepth === 2) {
          this.checkBounds(2);
          diff = this.view.getInt16(this.offset, true);
          this.offset += 2;
        } else if (byteDepth === 4) {
          this.checkBounds(4);
          diff = this.view.getInt32(this.offset, true);
          this.offset += 4;
        } else {
          throw new Error("Invalid byte depth");
        }

        lastValue += diff;
        rowValues.push(lastValue);
      }

      const scaledRow = rowValues.map((v) => v * vertScale + vertOffset);
      tileData.push(...scaledRow);
    }

    return tileData;
  }

  parse() {
    const header = this.readHeader();
    let extendedHeader: HF2ExtendedHeaderBlock[] = [];
    if (header.extHeaderLength > 0) {
      extendedHeader = this.readExtendedHeader(header.extHeaderLength);
    }

    const tiles = [];
    const tilesPerRow = Math.ceil(header.width / header.tileSize);
    const tilesPerCol = Math.ceil(header.height / header.tileSize);

    for (let row = 0; row < tilesPerCol; row++) {
      for (let col = 0; col < tilesPerRow; col++) {
        const remainingWidth = header.width - col * header.tileSize;
        const remainingHeight = header.height - row * header.tileSize;

        const tile = this.readTile(header.tileSize, remainingWidth, remainingHeight);
        tiles.push(tile);
      }
    }

    // stitch tiles together into a single array
    const stitchedTiles = [];
    for (let row = header.height - 1; row >= 0; row--) {
      const tileRow = Math.floor(row / header.tileSize);
      const tileRowOffset = row % header.tileSize;

      for (let col = 0; col < header.width; col++) {
        const tileCol = Math.floor(col / header.tileSize);
        const tileColOffset = col % header.tileSize;

        const tileIndex = tileRow * tilesPerRow + tileCol;
        const tile = tiles[tileIndex];

        const valueIndex = tileRowOffset * header.tileSize + tileColOffset;
        const value = tile[valueIndex];

        stitchedTiles.push(value);
      }
    }

    return { header, extendedHeader, tiles, stitchedTiles };
  }
}

export async function ungzipBlob(blob: Blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const compressedData = new Uint8Array(arrayBuffer);

  const decompressedData = await new Response(new Blob([compressedData]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();

  return new Uint8Array(decompressedData);
}

// Usage example
// const hf2Buffer = await fetch('path/to/file.hf2').then(res => res.arrayBuffer());
// const parser = new HF2Parser(hf2Buffer);
// const hf2Data = parser.parse();
// console.log(hf2Data);
