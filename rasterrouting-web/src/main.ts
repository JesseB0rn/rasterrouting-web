// filepath: /Users/jesseb0rn/Documents/repos/rasterrouting-web/src/main.ts
import { Feature, Map as MapGL } from "maplibre-gl/dist/maplibre-gl.js";
import "maplibre-gl/dist/maplibre-gl.css";
import { bboxToTile, getParent, Tile, tileToBBOX, getChildren, tileToQuadkey, tileToGeoJSON, pointToTileFraction, pointToTile, fracTileToPoint } from "./tilebelt";
import "@mapbox/sphericalmercator";
import Point from "@mapbox/point-geometry";
import type { BBox } from "geojson";
import PromisePool from "es6-promise-pool";
import { PriorityQueue } from "./pqueue";

const kClaculationZoomLevel = 15;
const kDEMUrl = "http://0.0.0.0:8000/services/rm.rgb/tiles/{z}/{x}/{y}.png";

var map = new MapGL({
  container: "map",
  style: "../style_light.json",
  maxZoom: 16,
  maxPitch: 80,
  center: [8.649673461914062, 46.97580176043127],
  zoom: 12,
});

let points = [];
let worker = new Worker(new URL('./worker.ts', import.meta.url));

worker.onmessage = (event) => {
  const path = event.data;
  // Handle the received path data (e.g., update the map)
  console.log("Received path from worker:", path);
};

map.on("click", (e) => {
  points.push(Point.convert([e.lngLat.lng, e.lngLat.lat]));

  let geojson = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [],
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

    worker.postMessage({ endpointA, endpointB });
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

// Other functions remain unchanged...