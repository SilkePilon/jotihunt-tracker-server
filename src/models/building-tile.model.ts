import mongoose, { type Connection, type Model } from "mongoose";

/**
 * One cached z15 tile of 3D buildings (from 3DBAG) in the control database, so it survives edition switches. `mvt` is the encoded
 * vector tile (layer "buildings", property h); null for a tile without buildings (cached too, so it isn't fetched again).
 */
export interface BuildingTileDoc {
  /** "15/x/y" */
  _id: string;
  mvt: Buffer | null;
  count: number;
  fetchedAt: Date;
}

const BuildingTileSchema = new mongoose.Schema<BuildingTileDoc>(
  {
    _id: { type: String, required: true },
    mvt: { type: Buffer, default: null },
    count: { type: Number, required: true },
    fetchedAt: { type: Date, required: true, index: true },
  },
  { collection: "building_tiles", versionKey: false },
);

/** The model on `connection` (the control store's connection to the control database; the test connection in tests). */
export function buildingTileModel(connection: Connection): Model<BuildingTileDoc> {
  return (connection.models.BuildingTile as Model<BuildingTileDoc> | undefined) ?? connection.model<BuildingTileDoc>("BuildingTile", BuildingTileSchema);
}
