import { Feature, Map as MapGL } from "maplibre-gl/dist/maplibre-gl.js";
import "maplibre-gl/dist/maplibre-gl.css";
import { bboxToTile, getParent, Tile, tileToBBOX, getChildren, tileToQuadkey, tileToGeoJSON } from "@mapbox/tilebelt";
import "@mapbox/sphericalmercator";
import Point from "@mapbox/point-geometry";
import type { BBox, Geometry } from "geojson";
import PromisePool from "es6-promise-pool";

const kClaculationZoomLevel = 15;
const kDEMUrl = "https://shop.robofactory.ch/swissalps/{z}/{x}/{y}.png";
// const kDEMUrl = "http://0.0.0.0:8000/services/swissalps/tiles/{z}/{x}/{y}.png";

var map = new MapGL({
  container: "map", // container id
  style: "../style_light.json", // style URL
  maxZoom: 16,
  maxPitch: 80,
  center: [8.649673461914062, 46.97580176043127],
  zoom: 12,
});

let points = [];

interface ITileData {
  tile: Tile;
  demData: Float32Array;
}
let loadedTiles = new Map<string, ITileData>();

map.on("click", (e) => {
  // console.log(e.lngLat);
  points.push(Point.convert([e.lngLat.lng, e.lngLat.lat]));

  let geojson = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [] as any,
        },
        properties: {},
      },
    ],
  };
  points.forEach((point) => {
    geojson.features[0].geometry.coordinates.push([point.x, point.y]);
  });
  console.log(geojson);
  (map.getSource("beeline") as unknown as any).setData(geojson);

  if (points.length >= 2) {
    const endpointA = points[points.length - 2];
    const endpointB = points[points.length - 1];
    const dist = sphmercdist(endpointA, endpointB);
    console.log(endpointA, endpointB, "dist=", dist);

    if (dist > 6000) {
      console.log("path too long, abort");
      return;
    }

    const tiles = identifyNeededTiles(endpointA, endpointB);
    const sortedTiles = toposortLoadingSrategy(tiles, endpointA, endpointB);
    // console.log(sortedTiles);
    loadTilesPooled(sortedTiles).then(() => {
      let geojson = {
        type: "FeatureCollection",
        features: [] as any[],
      };

      loadedTiles.forEach((tileData) => {
        const tile = tileData.tile;
        geojson.features.push({
          type: "Feature",
          geometry: tileToGeoJSON(tile),
          properties: {},
        });
      }) as any;
      console.log(geojson);
      (map.getSource("loaded_tiles") as unknown as any).setData(geojson);
    });
  }
});

const sphmercdist = (a: Point, b: Point): number => {
  const e = 0.081819191;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lat = (a.y + b.y) / 2;

  const adjustedX = (dx * Math.cos(lat)) / Math.sqrt(Math.pow(1 - e * e * Math.sin(lat) * Math.sin(lat), 2));
  const adjustedY = (dy * Math.cos(lat) * (1 - e * e)) / Math.pow(1 - e * e * Math.sin(lat) * Math.sin(lat), 3 / 2);

  const adjustedDistance = Math.hypot(adjustedX, adjustedY);
  return adjustedDistance * 40000;
};

/**
 * Find all tiles that could be needed to cover the path between endpointA and endpointB
 * @param endpointA Startpoint for the path
 * @param endpointB Ednpoint for the path
 * @returns Array of tiles that are needed to cover the path
 */
const identifyNeededTiles = (endpointA: Point, endpointB: Point): Tile[] => {
  const bbox = [endpointA.x, endpointA.y, endpointB.x, endpointB.y] as BBox;
  const rootTile = bboxToTile(bbox);
  let zLevel = rootTile[2];

  let stack = [rootTile];

  // we done fucked up because zoom level is already larger than kClaculationZoomLevel?
  while (zLevel > kClaculationZoomLevel) {
    const parent = getParent(stack[0]);
    stack = [parent];
    zLevel--;
  }

  // find all tiles that are needed to cover the bbox
  while (zLevel < kClaculationZoomLevel) {
    const newStack: Tile[] = [];
    stack.forEach((tile) => {
      const children = getChildren(tile);
      children.forEach((child) => {
        newStack.push(child);
      });
    });
    stack = newStack;
    zLevel++;
  }

  return stack;
};

const toposortLoadingSrategy = (tiles: Tile[], endpointA: Point, endpointB: Point): Tile[] => {
  // reject tiles if z is not equal to kClaculationZoomLevel
  let filteredTiles = tiles.filter((tile) => tile[2] === kClaculationZoomLevel);
  const endpointDist = sphmercdist(endpointA, endpointB);

  let dists = new Map<string, number[]>();

  filteredTiles.forEach((tile) => {
    const abbox = tileToBBOX(tile);
    const tileACenter = new Point((abbox[0] + abbox[2]) / 2, (abbox[1] + abbox[3]) / 2);
    const distanceAA = sphmercdist(endpointA, tileACenter);
    const distanceAB = sphmercdist(endpointB, tileACenter);
    dists.set(tileToQuadkey(tile), [Math.min(distanceAA, distanceAB), distanceAA, distanceAB]);
  });

  filteredTiles = filteredTiles.filter((tile) => {
    const packed = dists.get(tileToQuadkey(tile));
    const d = packed?.[0];
    const dA = packed?.[1];
    const dB = packed?.[2];
    if (!d || !dA || !dB) {
      return false;
    }
    // check if tiles are in the ellipse defined by the endpoints with major axis 24km
    if (dA + dB > endpointDist + 1500) {
      return false;
    }

    return true;
  });

  // sort tiles by distance to the path,
  const sortedTiles = filteredTiles.sort((tileA, tileB) => {
    return dists.get(tileToQuadkey(tileA))![0] - dists.get(tileToQuadkey(tileB))![0];
  });

  return sortedTiles;
};

const getTileURL = (tile: Tile) => {
  const url = kDEMUrl.replace("{z}", tile[2].toString()).replace("{x}", tile[0].toString()).replace("{y}", tile[1].toString());
  return url;
};

const loadTilesPooled = async (tiles: Tile[]) => {
  const urls = tiles.map((tile) => [getTileURL(tile), tile] as [string, Tile]);

  let totalSize = 0;
  const tileCount = urls.length;
  const start = new Date().getTime();

  const producer = () => {
    const a = urls.shift();
    if (!a) {
      return;
    }
    return new Promise<ITileData>((res, reject) => {
      fetch(a[0]).then((resp) => {
        resp.blob().then((blob) => {
          // console.log("loaded", a, blob.size);
          totalSize += blob.size;
          getRGBDEMBitmap(blob).then((dem) => {
            // console.log(dem);
            if (!dem) {
              reject("could not load dem");
              return;
            }
            const tileData = { tile: a[1], demData: dem.demData };
            loadedTiles.set(tileToQuadkey(a[1]), tileData);
            res(tileData);
          });
        });
      });
    });
  };

  const pool = new PromisePool(producer, 16);

  await pool.start();
  const time = (new Date().getTime() - start) / 1000;
  console.log(`loaded ${tileCount} tiles with a total size of ${totalSize / 1024 / 1024} MB in ${time}s`);
};

const getRGBDEMBitmap = async (blob: Blob) => {
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
    demData[i] = r * 256 + g + b / 256;
  }

  return { demData }; // Return width, height, and decoded DEM
};
