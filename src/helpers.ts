import Point from "@mapbox/point-geometry";
import { bboxToTile, getChildren, getParent, Tile, tileToBBOX, tileToQuadkey } from "./tilebelt";
import { kClaculationZoomLevel } from "./constants";
import type { BBox } from "geojson";
import type { IPathNode } from "./interfaces/tileData";

export function sphmercdist(a: Point, b: Point): number {
  const e = 0.081819191;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lat = (a.y + b.y) / 2;

  const adjustedX = (dx * Math.cos(lat)) / Math.sqrt(Math.pow(1 - e * e * Math.sin(lat) * Math.sin(lat), 2));
  const adjustedY = (dy * Math.cos(lat) * (1 - e * e)) / Math.pow(1 - e * e * Math.sin(lat) * Math.sin(lat), 3 / 2);

  const adjustedDistance = Math.hypot(adjustedX, adjustedY);
  return adjustedDistance * 40000;
}

/**
 * Find all tiles that could be needed to cover the path between endpointA and endpointB
 * @param endpointA Startpoint for the path
 * @param endpointB Ednpoint for the path
 * @returns Array of tiles that are needed to cover the path
 */
export function identifyNeededTiles(endpointA: Point, endpointB: Point): Tile[] {
  const bbox = [endpointA.x, endpointA.y, endpointB.x, endpointB.y] as BBox;
  const rootTile = bboxToTile(bbox);

  const rootTileParent = getParent(getParent(rootTile));

  let zLevel = rootTileParent[2];

  let stack = [rootTileParent];

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
}

export function toposortLoadingSrategy(tiles: Tile[], endpointA: Point, endpointB: Point): Tile[] {
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
    if (dA + dB > endpointDist * 1.5 + 1500) {
      return false;
    }

    return true;
  });

  // sort tiles by distance to the path,
  const sortedTiles = filteredTiles.sort((tileA, tileB) => {
    return dists.get(tileToQuadkey(tileA))![0] - dists.get(tileToQuadkey(tileB))![0];
  });

  return sortedTiles;
}

export function simplifyPath(path: IPathNode[], epsilon: number): IPathNode[] {
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
}

export function smoothPath(path: number[][]): number[][] {
  if (path.length < 2) return path;

  let newPath = path.map((node) => ({ ...node }));

  for (let iters = 0; iters < 3; iters++) {
    const smoothed: number[][] = [];
    for (let i = 0; i < newPath.length - 1; i++) {
      const p1 = newPath[i];
      const p2 = newPath[i + 1];

      const x1new = 0.75 * p1[0] + 0.25 * p2[0];
      const y1new = 0.75 * p1[1] + 0.25 * p2[1];
      const x2new = 0.25 * p1[0] + 0.75 * p2[0];
      const y2new = 0.25 * p1[1] + 0.75 * p2[1];

      smoothed.push([x1new, y1new]);
      smoothed.push([x2new, y2new]);
    }
    newPath = smoothed;
  }

  return [path[0], ...newPath, path[path.length - 1]];
}

export function findNeighbours(src: IPathNode): IPathNode[] {
  let neighbors = [] as IPathNode[];
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
}
