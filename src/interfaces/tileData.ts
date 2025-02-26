import { Tile } from "../tilebelt";

export interface ITileData {
  tile: Tile;
  data: Float32Array;
}

export interface IPathNode {
  px_X: number;
  px_Y: number;
  tile: Tile;
  cost?: number;
  heuristic?: number;
}
