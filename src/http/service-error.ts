import type { Response } from "express";

/** An expected failure of a service call: answered with `status` and `{ message, ...details }`. */
export class ServiceError extends Error {
  status: number;
  details: Record<string, unknown>;

  constructor(status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Run a service call and answer with its result (no body for 204); a ServiceError becomes its status and message. */
export async function respond(res: Response, status: number, action: () => Promise<unknown>) {
  try {
    const result = await action();
    return status === 204 ? res.status(204).end() : res.status(status).json(result);
  } catch (error) {
    if (error instanceof ServiceError) {
      return res.status(error.status).json({ message: error.message, ...error.details });
    }
    throw error;
  }
}
