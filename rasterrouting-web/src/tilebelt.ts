// filepath: /Users/jesseb0rn/Documents/repos/rasterrouting-web/src/tilebelt.ts

// This file contains utility functions related to tile calculations, such as converting between tile coordinates and geographical coordinates.

export const bboxToTile = (bbox: number[]): number[] => {
  // Convert bounding box to tile coordinates
  const [minX, minY, maxX, maxY] = bbox;
  const tileX = Math.floor((minX + 180) / 360 * Math.pow(2, 15)); // Assuming zoom level 15
  const tileY = Math.floor((1 - Math.log(Math.tan(minY * Math.PI / 180) + 1 / Math.cos(minY * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, 15));
  return [tileX, tileY, 15];
};

export const tileToBBOX = (tile: number[]): number[] => {
  // Convert tile coordinates to bounding box
  const [x, y, z] = tile;
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  const lon1 = (x / Math.pow(2, z) * 360 - 180);
  const lat1 = (180 / Math.PI * Math.atan(Math.sinh(n)));
  const lon2 = ((x + 1) / Math.pow(2, z) * 360 - 180);
  const lat2 = (180 / Math.PI * Math.atan(Math.sinh(n)));
  return [lon1, lat1, lon2, lat2];
};

export const pointToTile = (lng: number, lat: number, zoom: number): number[] => {
  // Convert geographical coordinates to tile coordinates
  const tileX = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
  const tileY = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
  return [tileX, tileY, zoom];
};

export const pointToTileFraction = (lng: number, lat: number, zoom: number): number[] => {
  // Convert geographical coordinates to tile fraction coordinates
  const tile = pointToTile(lng, lat, zoom);
  const tileSize = 256; // Assuming tile size of 256x256
  const xFraction = ((lng + 180) / 360 * Math.pow(2, zoom) * tileSize) % tileSize;
  const yFraction = ((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom) * tileSize) % tileSize;
  return [xFraction, yFraction, zoom];
};

export const fracTileToPoint = (tile: number[]): number[] => {
  // Convert fractional tile coordinates to geographical coordinates
  const [x, y, z] = tile;
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  const lon = x / Math.pow(2, z) * 360 - 180;
  const lat = 180 / Math.PI * Math.atan(Math.sinh(n));
  return [lon, lat];
};

export const getChildren = (tile: number[]): number[][] => {
  // Get child tiles of a given tile
  const [x, y, z] = tile;
  return [
    [x * 2, y * 2, z + 1],
    [x * 2 + 1, y * 2, z + 1],
    [x * 2, y * 2 + 1, z + 1],
    [x * 2 + 1, y * 2 + 1, z + 1],
  ];
};

export const getParent = (tile: number[]): number[] => {
  // Get parent tile of a given tile
  const [x, y, z] = tile;
  return [Math.floor(x / 2), Math.floor(y / 2), z - 1];
};

export const tileToQuadkey = (tile: number[]): string => {
  // Convert tile coordinates to quadkey
  const [x, y, z] = tile;
  let quadkey = '';
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit++;
    if ((y & mask) !== 0) digit += 2;
    quadkey += digit.toString();
  }
  return quadkey;
};

export const tileToGeoJSON = (tile: number[]): any => {
  // Convert tile coordinates to GeoJSON format
  const bbox = tileToBBOX(tile);
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [[
        [bbox[0], bbox[1]],
        [bbox[2], bbox[1]],
        [bbox[2], bbox[3]],
        [bbox[0], bbox[3]],
        [bbox[0], bbox[1]]
      ]]
    },
    properties: {}
  };
};