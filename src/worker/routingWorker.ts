import { Point } from "maplibre-gl";
import { kClaculationZoomLevel, kDEMUrl, kRMUrl } from "../constants";
import { findNeighbours, identifyNeededTiles, simplifyPath, smoothPath, toposortLoadingSrategy } from "../helpers";
import { fracTileToPoint, pointToTile, pointToTileFraction, Tile, tileToGeoJSON, tileToQuadkey } from "../tilebelt";
import { TileSource } from "../tilesource";
import { PriorityQueue } from "../pqueue";
import { IPathNode } from "../interfaces/tileData";

const DEMTileSource = new TileSource(kDEMUrl, "RGB");
const RMTileSource = new TileSource(kRMUrl, "HFZ");

onmessage = (e) => {
  console.log("routingWorker received message", e.data);

  if (e.data.endpointA && e.data.endpointB) {
    const tiles = identifyNeededTiles(e.data.endpointA, e.data.endpointB);
    const sortedTiles = toposortLoadingSrategy(tiles, e.data.endpointA, e.data.endpointB);
    // console.log(sortedTiles);

    Promise.all([RMTileSource.loadTilesPooled(sortedTiles), DEMTileSource.loadTilesPooled(sortedTiles)]).then(async () => {
      let geojson = {
        type: "FeatureCollection",
        features: [] as any[],
      };

      RMTileSource.tileAtlas.forEach((tileData) => {
        const tile = tileData.tile;
        geojson.features.push({
          type: "Feature",
          geometry: tileToGeoJSON(tile),
          properties: {},
        });
      }) as any;
      console.log(geojson);

      postMessage({ loadedTiles: geojson });
      // (map.getSource("loaded_tiles") as unknown as any).setData(geojson);

      const rawPath = runSearch(e.data.endpointA, e.data.endpointB) ?? [];
      const simplified = simplifyPath(rawPath, 6.5);

      const wgs84 = simplified.map((point) => {
        const _tile = [point.tile[0] + point.px_X / 256, point.tile[1] + point.px_Y / 256, point.tile[2]] as Tile;
        return fracTileToPoint(_tile);
      });

      const smoothed = smoothPath(wgs84);

      console.log("smoothed path", smoothed);

      postMessage({ path: smoothed });
    });
  }
};

const runSearch = (endpointA: Point, endpointB: Point) => {
  const createIfNotExistsGuard = (key: string) => {
    if (visitedTiles.get(key) === undefined) {
      // console.log("creating for", key, "set of tiles:", visitedTiles.size);
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
          // console.log("backtracking", currentTile, "from", cindex);
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
