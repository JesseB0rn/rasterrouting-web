import { Feature, Map as MapGL } from "maplibre-gl/dist/maplibre-gl.js";
import "maplibre-gl/dist/maplibre-gl.css";
import { bboxToTile, getParent, Tile, tileToBBOX, getChildren, tileToQuadkey, tileToGeoJSON, pointToTileFraction, pointToTile, fracTileToPoint } from "./tilebelt";
import "@mapbox/sphericalmercator";
import Point from "@mapbox/point-geometry";
import type { BBox, Geometry } from "geojson";
import PromisePool from "es6-promise-pool";
import { PriorityQueue } from "./pqueue";

const kClaculationZoomLevel = 14;
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

      const rawPath = runSearch(endpointA, endpointB) ?? [];
      const simplified = simplifyPath(rawPath, 5.5);
      // const simplified = rawPath;

      let pathGeojson = {
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
      simplified.forEach((point) => {
        const _tile = [point.tile[0] + point.px_X / 256, point.tile[1] + point.px_Y / 256, point.tile[2]] as Tile;
        pathGeojson.features[0].geometry.coordinates.push(fracTileToPoint(_tile));
      });
      console.log(pathGeojson);
      (map.getSource("path") as unknown as any).setData(pathGeojson);
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

interface IPathNode {
  px_X: number;
  px_Y: number;
  tile: Tile;
  cost?: number;
  heuristic?: number;
}

const findNeighbours = (src: IPathNode): IPathNode[] => {
  let neighbors = [] as IPathNode[];
  let tile = [src.tile[0], src.tile[1], src.tile[2]] as Tile;
  const px_X = src.px_X;
  const px_Y = src.px_Y;

  // chess king moves, 8 directions, check if the px is 0 or 255, and jump to the next tile if needed
  const wrapXneg = px_X === 0;
  const wrapXpos = px_X === 255;
  const wrapYneg = px_Y === 0;
  const wrapYpos = px_Y === 255;

  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      if (i === 0 && j === 0) {
        continue;
      }

      let x = px_X + i;
      let y = px_Y + j;
      let tile = [src.tile[0], src.tile[1], src.tile[2]] as Tile;

      if (wrapXneg && i === -1) {
        x = 255;
        tile[0]--;
      }
      if (wrapXpos && i === 1) {
        x = 0;
        tile[0]++;
      }
      if (wrapYneg && j === -1) {
        y = 255;
        tile[1]--;
      }
      if (wrapYpos && j === 1) {
        y = 0;
        tile[1]++;
      }

      neighbors.push({ px_X: x, px_Y: y, tile: [tile[0], tile[1], tile[2]] });
    }
  }
  return neighbors;
};

// const cameFromMap = {
//   0: 7,
//   1: 6,
//   2: 5,
//   3: 4,
//   4: 3,
//   5: 2,
//   6: 1,
//   7: 0,
// };

const runSearch = (endpointA: Point, endpointB: Point) => {
  const createIfNotExistsGuard = (key: string) => {
    if (visitedTiles.get(key) === undefined) {
      console.log("creating for", key, "set of tiles:", visitedTiles.size);
      visitedTiles.set(
        key,
        new Array(256).fill(false).map(() => new Array(256).fill(false))
      );
      accumulatedCost.set(
        key,
        new Array(256).fill(9e99).map(() => new Array(256).fill(9e99))
      );
      cameFrom.set(
        key,
        new Array(256).fill(-1).map(() => new Array(256).fill(-1))
      );
    }
  };

  const starttilefrac = pointToTileFraction(endpointA.x, endpointA.y, kClaculationZoomLevel);
  const startTile = pointToTile(endpointA.x, endpointA.y, kClaculationZoomLevel);
  const endtilefrac = pointToTileFraction(endpointB.x, endpointB.y, kClaculationZoomLevel);
  const endTile = pointToTile(endpointB.x, endpointB.y, kClaculationZoomLevel);

  console.log("start", starttilefrac, startTile);
  console.log("end", endtilefrac, endTile);

  const startpixel = [Math.floor((starttilefrac[0] - Math.floor(starttilefrac[0])) * 256), Math.floor((starttilefrac[1] - Math.floor(starttilefrac[1])) * 256)];
  const endpixel = [Math.floor((endtilefrac[0] - Math.floor(endtilefrac[0])) * 256), Math.floor(endtilefrac[1] * 256 - Math.floor(endtilefrac[1]) * 256)];

  let visitedTiles = new Map<string, boolean[][]>();
  let accumulatedCost = new Map<string, number[][]>();
  let cameFrom = new Map<string, number[][]>(); // camefrom direction, as neighbor index

  let queue = new PriorityQueue<IPathNode>((a, b) => (a.cost ?? 9e99) + (a.heuristic ?? 9e99) < (b.cost ?? 9e99) + (b.heuristic ?? 9e99));

  queue.push({ px_X: startpixel[0], px_Y: startpixel[1], tile: [startTile[0], startTile[1], kClaculationZoomLevel], cost: 0, heuristic: 0 });

  while (!queue.isEmpty()) {
    const current = queue.pop();
    const key = tileToQuadkey(current.tile);

    if (visitedTiles.get(key)?.[current.px_X]?.[current.px_Y]) {
      continue;
    }

    createIfNotExistsGuard(key);

    visitedTiles.get(key)![current.px_X][current.px_Y] = true;
    accumulatedCost.get(key)![current.px_X][current.px_Y] = current.cost ?? 9e99;

    const neighbors = findNeighbours(current);

    if (current.tile[0] === endTile[0] && current.tile[1] === endTile[1]) {
      if (current.px_X === endpixel[0] && current.px_Y === endpixel[1]) {
        console.log("found end pixel, backtracking");
        let path = [] as IPathNode[];
        let currentTile = { ...current };
        while (currentTile.tile[0] !== startTile[0] || currentTile.tile[1] !== startTile[1] || currentTile.px_X !== startpixel[0] || currentTile.px_Y !== startpixel[1]) {
          const ckey = tileToQuadkey(currentTile.tile);
          const cindex = cameFrom.get(ckey)![currentTile.px_X][currentTile.px_Y];
          const neigbrs = findNeighbours(currentTile);
          path.push(currentTile);
          console.log("backtracking", currentTile, "from", cindex);
          currentTile = neigbrs[7 - cindex];
        }
        console.log("found path", path);
        return path;
      }
    }

    // neighbors.forEach((neighbor, nindex) => { });

    for (let nindex = 0; nindex < neighbors.length; nindex++) {
      const neighbor = neighbors[nindex];

      // console.log("checking neighbor", neighbor, "from", current.cost);

      const nkey = tileToQuadkey(neighbor.tile);
      if (visitedTiles.get(nkey)?.[neighbor.px_X]?.[neighbor.px_Y]) {
        continue;
      }
      createIfNotExistsGuard(nkey);

      const tileData = loadedTiles.get(nkey);
      if (!tileData) {
        // console.log("no tile data for", nkey);
        continue;
      }
      const currentHeight = tileData.demData[current.px_Y * 256 + current.px_X];
      const neighborHeight = tileData.demData[neighbor.px_Y * 256 + neighbor.px_X];
      const newCost = (current.cost ?? 0) + 1 + Math.abs(currentHeight - neighborHeight);

      if (!visitedTiles.get(nkey)![neighbor.px_X][neighbor.px_Y] && newCost < accumulatedCost.get(nkey)![neighbor.px_X][neighbor.px_Y]) {
        accumulatedCost.get(nkey)![neighbor.px_X][neighbor.px_Y] = newCost;
        // const heuristic = Math.hypot(neighbor.px_X - endpixel[0], neighbor.px_Y - endpixel[1]);
        cameFrom.get(nkey)![neighbor.px_X][neighbor.px_Y] = nindex;

        queue.push({ px_X: neighbor.px_X, px_Y: neighbor.px_Y, tile: [neighbor.tile[0], neighbor.tile[1], neighbor.tile[2]], cost: newCost, heuristic: 0 });
      }
    }
  }
  if (queue.isEmpty()) {
    alert("no path found");
    return;
  }
};

const simplifyPath = (path: IPathNode[], epsilon: number): IPathNode[] => {
  if (path.length < 3) return path;

  const distanceToLine = (pA: IPathNode, pTest: IPathNode, pB: IPathNode): number => {
    const A = pB.px_Y - pA.px_Y;
    const B = pA.px_X - pB.px_X;
    const C = pB.px_X * pA.px_Y - pA.px_X * pB.px_Y;

    return Math.abs(A * pTest.px_X + B * pTest.px_Y + C) / Math.sqrt(A * A + B * B);
  };

  const douglasPeucker = (start: number, end: number): IPathNode[] => {
    let maxDistance = 0;
    let farthestIndex = start;

    for (let i = start + 1; i < end; i++) {
      const distance = distanceToLine(path[start], path[i], path[end]);
      if (distance > maxDistance) {
        maxDistance = distance;
        farthestIndex = i;
      }
    }

    if (maxDistance > epsilon) {
      const recResults1 = douglasPeucker(start, farthestIndex);
      const recResults2 = douglasPeucker(farthestIndex, end);
      return [...recResults1.slice(0, -1), ...recResults2];
    } else {
      return [path[start], path[end]];
    }
  };

  return douglasPeucker(0, path.length - 1);
};
