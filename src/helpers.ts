import Point from "@mapbox/point-geometry";
import { bboxToTile, getChildren, getParent, Tile, tileToBBOX, tileToQuadkey } from "./tilebelt";
import { kClaculationZoomLevel } from "./constants";
import type { BBox } from "geojson";

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
}
