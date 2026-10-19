import { Request, Response } from "express";
import { ServiceError } from "../http/service-error";
import { requireFastfoodService } from "../services/fastfood.service";

/** Every McDonald's, KFC and Burger King with its open intervals (the map's fastfood layers). */
export async function list(_req: Request, res: Response) {
  try {
    const items = await requireFastfoodService().list();
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.status(200).json(items);
  } catch (error) {
    if (error instanceof ServiceError) return res.status(error.status).json({ message: error.message });
    throw error;
  }
}
