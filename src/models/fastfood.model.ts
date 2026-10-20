import mongoose, { type Connection, type Model } from "mongoose";
import type { Restaurant } from "../services/fastfood.helpers";

export type FastfoodDoc = Restaurant;

const FastfoodSchema = new mongoose.Schema<FastfoodDoc>(
  {
    osmId: { type: String, required: true, unique: true },
    brand: { type: String, required: true, enum: ["mcdonalds", "kfc", "burgerking"] },
    branch: String,
    location: {
      type: { type: String, enum: ["Point"], required: true },
      coordinates: { type: [Number], required: true },
    },
    street: String,
    houseNumber: String,
    postcode: String,
    city: String,
    phone: String,
    website: String,
    driveThrough: Boolean,
    openingHours: String,
    updatedAt: { type: Date, required: true, index: true },
  },
  { collection: "fastfood", versionKey: false },
);

/**
 * McDonald's / KFC / Burger King from OpenStreetMap in the control database (the control store's connection), so the
 * cache survives edition switches; the test connection in tests.
 */
export function fastfoodModel(connection: Connection): Model<FastfoodDoc> {
  return (connection.models.Fastfood as Model<FastfoodDoc> | undefined) ?? connection.model<FastfoodDoc>("Fastfood", FastfoodSchema);
}
