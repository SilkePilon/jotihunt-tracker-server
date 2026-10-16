import { ServiceError } from "../http/service-error";

/** The one instance of a service in this process: set by the startup wiring (index.ts) or a test, null until then. */
export interface ServiceSlot<T> {
  get(): T | null;
  set(service: T | null): void;
  /** The instance, or a 503 ServiceError with the slot's message when none is set */
  require(): T;
}

export function serviceSlot<T>(unavailableMessage: string): ServiceSlot<T> {
  let instance: T | null = null;
  return {
    get: () => instance,
    set: (service) => {
      instance = service;
    },
    require: () => {
      if (!instance) throw new ServiceError(503, unavailableMessage);
      return instance;
    },
  };
}
