import { describe, expect, test } from "bun:test";
import { describeTraccarError, isGroupInvalidError } from "./traccar-http";

/** A duck-typed AxiosError good enough for `axios.isAxiosError`, carrying a secret Authorization header. */
function mockAxiosError(overrides: Record<string, unknown> = {}) {
  return {
    isAxiosError: true,
    message: "Request failed with status code 400",
    config: {
      method: "post",
      url: "https://traccar.test/api/devices?token=super-secret-query-token",
      headers: { Authorization: "Bearer super-secret-admin-token" },
    },
    response: { status: 400, data: { message: "groupId does not exist" } },
    ...overrides,
  };
}

describe("describeTraccarError", () => {
  test("summarises method, url (without query string) and status — never the Authorization header or body", () => {
    const description = describeTraccarError(mockAxiosError());
    expect(description).toBe("POST https://traccar.test/api/devices → 400");
    expect(description).not.toContain("Bearer");
    expect(description).not.toContain("super-secret-admin-token");
    expect(description).not.toContain("super-secret-query-token");
    expect(description).not.toContain("Authorization");
  });

  test("a network failure (no response) uses the axios error code", () => {
    const description = describeTraccarError(mockAxiosError({ response: undefined, code: "ECONNREFUSED" }));
    expect(description).toBe("POST https://traccar.test/api/devices → ECONNREFUSED");
    expect(description).not.toContain("Bearer");
  });

  test("non-axios errors fall back to the message", () => {
    expect(describeTraccarError(new Error("boom"))).toBe("boom");
    expect(describeTraccarError("boom")).toBe("boom");
  });
});

describe("isGroupInvalidError", () => {
  test("true for a 400 response mentioning the group", () => {
    expect(isGroupInvalidError(mockAxiosError())).toBe(true);
  });

  test("false for a 400 about something else, a non-400 status, or a non-axios error", () => {
    expect(isGroupInvalidError(mockAxiosError({ response: { status: 400, data: { message: "name is required" } } }))).toBe(false);
    expect(isGroupInvalidError(mockAxiosError({ response: { status: 500, data: { message: "group" } } }))).toBe(false);
    expect(isGroupInvalidError(new Error("group"))).toBe(false);
  });
});
