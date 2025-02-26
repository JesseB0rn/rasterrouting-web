import { Map as MapGL } from "maplibre-gl/dist/maplibre-gl.js";
import "maplibre-gl/dist/maplibre-gl.css";
import { Tile, tileToQuadkey, pointToTileFraction, pointToTile, fracTileToPoint, tileToGeoJSON } from "./tilebelt";
import "@mapbox/sphericalmercator";
import Point from "@mapbox/point-geometry";
import { PriorityQueue } from "./pqueue";
import { TileSource } from "./tilesource";
import { kClaculationZoomLevel, kDEMUrl, kRMUrl } from "./constants";
import { identifyNeededTiles, simplifyPath, sphmercdist, toposortLoadingSrategy, smoothPath } from "./helpers";
import { IPathNode } from "./interfaces/tileData";

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

    if (window.Worker) {
      const worker = new Worker(new URL("./worker/routingWorker.ts", import.meta.url), { type: "module" });
      worker.postMessage({ endpointA, endpointB });
      worker.onmessage = async (e) => {
        console.log("main received message", e.data);
        if (e.data.loadedTiles) {
          console.log("main received loadedTiles", e.data);
          (map.getSource("loaded_tiles") as unknown as any).setData(e.data.loadedTiles);
        }
        if (e.data.path) {
          console.log("routingWorker msg returned pathdata", e.data);
          let pathGeojson = await (map.getSource("path") as unknown as any).getData();

          const smoothed: number[][] = e.data.path;
          if (!pathGeojson) {
            pathGeojson = {
              type: "FeatureCollection",
              features: [] as any[],
            };
          }
          let segment = {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [] as any,
            },
            properties: {},
          };
          smoothed.forEach((point) => {
            segment.geometry.coordinates.push(point);
          });
          console.log(pathGeojson);
          pathGeojson.features.push(segment);
          (map.getSource("path") as unknown as any).setData(pathGeojson);
        }
      };
    }
  }
});
