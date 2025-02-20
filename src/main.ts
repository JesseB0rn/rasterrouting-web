import { Map } from "maplibre-gl/dist/maplibre-gl.js";
import "maplibre-gl/dist/maplibre-gl.css";
import { bboxToTile, getParent, Tile, tileToBBOX } from "@mapbox/tilebelt";
import "@mapbox/sphericalmercator";
import Point from "@mapbox/point-geometry";
import { pointToTile, getChildren } from "@mapbox/tilebelt";
import type { BBox } from "geojson";
import PromisePool from "es6-promise-pool";

const kClaculationZoomLevel = 15;
const kDEMUrl = "https://shop.robofactory.ch/swissalps/{z}/{x}/{y}.png";

var map = new Map({
  container: "map", // container id
  style: "../style_light.json", // style URL
  maxZoom: 16,
  maxPitch: 80,
  center: [8.649673461914062, 46.97580176043127],
  zoom: 12,
});

let points = [];

map.on("click", (e) => {
  console.log(e.lngLat);
  points.push(Point.convert([e.lngLat.lng, e.lngLat.lat]));

  if (points.length >= 2) {
    const endpointA = points[points.length - 2];
    const endpointB = points[points.length - 1];
    const tiles = identifyNeededTiles(endpointA, endpointB);
    const sortedTiles = toposortLoadingSrategy(tiles, endpointA, endpointB);
    console.log(sortedTiles);
    loadTilesPooled(sortedTiles);
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
  return adjustedDistance;
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
  const filteredTiles = tiles.filter((tile) => tile[2] === kClaculationZoomLevel);

  // sort tiles by distance to the path,
  const sortedTiles = filteredTiles.sort((tileA, tileB) => {
    const abbox = tileToBBOX(tileA);
    const tileACenter = new Point((abbox[0] + abbox[2]) / 2, (abbox[1] + abbox[3]) / 2);
    const distanceA = sphmercdist(endpointA, tileACenter);

    const bbbox = tileToBBOX(tileB);
    const tileBCenter = new Point((bbbox[0] + bbbox[2]) / 2, (bbbox[1] + bbbox[3]) / 2);
    const distanceB = sphmercdist(endpointB, tileBCenter);

    return distanceA - distanceB;
  });

  return sortedTiles;
};

const getTileURL = (tile: Tile) => {
  const url = kDEMUrl.replace("{z}", tile[2].toString()).replace("{x}", tile[0].toString()).replace("{y}", tile[1].toString());
  // console.log(url);
  return url;
  // fetch(url).then(async (response) => {
  //   if (response.ok) {
  //     console.log("Tile loaded", await response.arrayBuffer());
  //   } else {
  //     console.log("Tile not loaded");
  //   }
  // });
};

const loadTilesPooled = async (tiles: Tile[]) => {
  const urls = tiles.map((tile) => getTileURL(tile));

  const producer = () => {
    const a = urls.shift();
    if (!a) {
      return;
    }
    return fetch(a);
  };

  const pool = new PromisePool(producer, 8);

  const results = await pool.start();
  console.log("done");
};
