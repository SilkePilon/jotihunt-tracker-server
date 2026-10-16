import { describe, expect, test } from "bun:test";
import { detectPhotoType } from "./image-type";

describe("detectPhotoType", () => {
  test("recognizes JPEG, PNG and WebP by their bytes", () => {
    expect(detectPhotoType(Buffer.from([0xff, 0xd8, 0xff, 0xe1]))).toBe("image/jpeg");
    expect(detectPhotoType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(detectPhotoType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toBe("image/webp");
  });

  test("anything else is null", () => {
    expect(detectPhotoType(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
    expect(detectPhotoType(Buffer.from("GIF89a"))).toBeNull();
    expect(detectPhotoType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]))).toBeNull();
    expect(detectPhotoType(Buffer.alloc(0))).toBeNull();
  });
});
