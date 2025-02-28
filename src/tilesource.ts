import PromisePool from "es6-promise-pool";
import { HF2Parser, ungzipBlob } from "./hf2parser";
import { ITileData } from "./interfaces/tileData";
import { Tile, tileToQuadkey } from "./tilebelt";

export class TileSource {
  tileAtlas = new Map<string, ITileData>();

  url: string;
  type: "RGB" | "HF2" | "HFZ";

  totalSize = 0;

  constructor(url: string, type: "RGB" | "HF2" | "HFZ") {
    this.url = url;
    this.type = type;
  }

  private loadTileRGB(a: [string, Tile]): Promise<ITileData> {
    return new Promise<ITileData>((res, reject) => {
      fetch(a[0])
        .then((resp) => {
          resp.blob().then((blob) => {
            // console.log("loaded", a, blob.size);
            this.totalSize += blob.size;
            this.getRGBDEMBitmap(blob).then((dem) => {
              // console.log(dem);
              if (!dem) {
                reject("could not decode rgb data");
                return;
              }
              const tileData = { tile: a[1], data: dem.demData };
              this.tileAtlas.set(tileToQuadkey(a[1]), tileData);
              res(tileData);
            });
          });
        })
        .catch((e) => {
          console.error(e);
          // reject(e);
        });
    });
  }

  private loadTileHFZ(a: [string, Tile]): Promise<ITileData> {
    return new Promise<ITileData>((res, reject) => {
      fetch(a[0])
        .then((resp) => {
          resp.blob().then(async (blob) => {
            this.totalSize += blob.size;
            const uncompressed = await ungzipBlob(blob);
            const parser = new HF2Parser(uncompressed.buffer);
            const data = new Float32Array(parser.parse().stitchedTiles);
            const tileData = { tile: a[1], data: data };
            this.tileAtlas.set(tileToQuadkey(a[1]), tileData);
            res(tileData);
          });
        })
        .catch((e) => {
          console.error(e);
          reject(e);
        });
    });
  }

  public async loadTilesPooled(tiles: Tile[]): Promise<void> {
    const urls = tiles.map((tile) => [this.getTileURL(tile), tile] as [string, Tile]);

    const tileCount = urls.length;
    const start = new Date().getTime();

    const producer = () => {
      const a = urls.shift();
      if (!a) {
        return;
      }

      let promise: Promise<ITileData>;

      if (this.type === "RGB") {
        promise = this.loadTileRGB(a);
      } else if (this.type === "HFZ") {
        promise = this.loadTileHFZ(a);
      } else {
        throw new Error("unsupported tile type / not impolemted yet");
      }
      return promise;
    };

    const pool = new PromisePool(producer, 16);

    await pool.start();
    const time = (new Date().getTime() - start) / 1000;
    console.log(`loaded ${tileCount} tiles with a total size of ${this.totalSize / 1024 / 1024} MB in ${time}s`);
  }
  getTileURL(tile: Tile): string {
    const turl = this.url.replace("{z}", tile[2].toString()).replace("{x}", tile[0].toString()).replace("{y}", tile[1].toString());
    return turl;
  }

  private async getRGBDEMBitmap(blob: Blob) {
    const image = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("could not get context");
      return undefined;
    }

    ctx.drawImage(image, 0, 0);
    const imageData = ctx.getImageData(0, 0, image.width, image.height);
    const pixels = imageData.data; // Uint8ClampedArray (RGBA format)

    const width = image.width;
    const height = image.height;
    const demData = new Float32Array(width * height); // Store height values

    for (let i = 0; i < width * height; i++) {
      const r = pixels[i * 4]; // Red channel
      const g = pixels[i * 4 + 1]; // Green channel
      const b = pixels[i * 4 + 2]; // Blue channel

      // Decode height using common RGB-DEM formula
      demData[i] = -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
    }

    return { demData }; // Return width, height, and decoded DEM
  }
}
