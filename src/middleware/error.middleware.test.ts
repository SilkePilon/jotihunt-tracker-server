import { describe, expect, test } from "bun:test";
import { isDatabaseUnavailable } from "./error.middleware";

const named = (name: string, message = "x") => Object.assign(new Error(message), { name });

describe("isDatabaseUnavailable", () => {
  test("connection errors of the driver and mongoose", () => {
    for (const name of ["MongoNetworkError", "MongoServerSelectionError", "MongooseServerSelectionError", "MongoNotConnectedError", "MongoTopologyClosedError", "MongoPoolClearedError", "MongoNetworkTimeoutError"]) {
      expect(isDatabaseUnavailable(named(name))).toBe(true);
    }
    expect(isDatabaseUnavailable(named("MongooseError", "Operation `users.findOne()` buffering timed out after 10000ms"))).toBe(true);
  });

  test("other errors are not", () => {
    expect(isDatabaseUnavailable(new Error("bug"))).toBe(false);
    expect(isDatabaseUnavailable(named("MongoServerError", "E11000 duplicate key"))).toBe(false);
    expect(isDatabaseUnavailable(named("ValidationError"))).toBe(false);
    expect(isDatabaseUnavailable("MongoNetworkError")).toBe(false);
  });
});
