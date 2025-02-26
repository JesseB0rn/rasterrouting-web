import { Map as MapGL } from "maplibre-gl/dist/maplibre-gl.js";
import "maplibre-gl/dist/maplibre-gl.css";
import { Tile, tileToQuadkey, tileToGeoJSON, pointToTileFraction, pointToTile, fracTileToPoint } from "./tilebelt";
import "@mapbox/sphericalmercator";
import Point from "@mapbox/point-geometry";
import { PriorityQueue } from "./pqueue";
import { TileSource } from "./tilesource";
import { kClaculationZoomLevel, kDEMUrl, kRMUrl } from "./constants";
import { identifyNeededTiles, sphmercdist, toposortLoadingSrategy } from "./helpers";

const DEMTileSource = new TileSource(kDEMUrl, "RGB");
const RMTileSource = new TileSource(kRMUrl, "HFZ");

var map = new MapGL({
  container: "map", // container id
  style: "../style_light.json", // style URL
  maxZoom: 16,
  maxPitch: 80,
  center: [8.649673461914062, 46.97580176043127],
  zoom: 12,
});

let points = [];

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

    Promise.all([RMTileSource.loadTilesPooled(sortedTiles), DEMTileSource.loadTilesPooled(sortedTiles)]).then(() => {
      // let geojson = {
      //   type: "FeatureCollection",
      //   features: [] as any[],
      // };

      // RMTileSource.tileAtlas.forEach((tileData) => {
      //   const tile = tileData.tile;
      //   geojson.features.push({
      //     type: "Feature",
      //     geometry: tileToGeoJSON(tile),
      //     properties: {},
      //   });
      // }) as any;
      // console.log(geojson);
      // (map.getSource("loaded_tiles") as unknown as any).setData(geojson);

      const rawPath = runSearch(endpointA, endpointB) ?? [];
      const simplified = simplifyPath(rawPath, 6.5);
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
    DEMTileSource.loadTilesPooled(sortedTiles).then(() => {});
  }
});

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

      const [DEMTileData, RMTileData] = [DEMTileSource.tileAtlas.get(nkey), RMTileSource.tileAtlas.get(nkey)];
      if (!DEMTileData || !RMTileData) {
        // console.log("no tile data for", nkey);
        continue;
      }
      const riskCost = RMTileData.data[neighbor.px_Y * 256 + neighbor.px_X];
      const currentHeight = DEMTileData.data[current.px_Y * 256 + current.px_X];
      const neighborHeight = DEMTileData.data[neighbor.px_Y * 256 + neighbor.px_X];

      const horizontalDistance = Math.hypot(neighbor.px_X - current.px_X, neighbor.px_Y - current.px_Y) * 6.515;
      const verticalDistance = neighborHeight - currentHeight;

      const slope = verticalDistance / horizontalDistance;
      const toblerCost = 0.6 * Math.E ** (3.5 * Math.abs(slope + 0.05));

      const newCost = (current.cost ?? 0) + toblerCost + riskCost * 25.0;

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
