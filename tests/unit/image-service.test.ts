import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { sniffImageMime, validateRawUpload, ImageValidationError } from "../../packages/domain/media/image-service";

async function realImageBuffer(format: "jpeg" | "png" | "webp"): Promise<Buffer> {
  const image = sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 120, b: 40 } } });
  if (format === "jpeg") return image.jpeg().toBuffer();
  if (format === "png") return image.png().toBuffer();
  return image.webp().toBuffer();
}

describe("sniffImageMime — magic-byte MIME detection (never trusts extension/declared Content-Type)", () => {
  it("recognizes a real JPEG by its magic bytes", async () => {
    expect(sniffImageMime(await realImageBuffer("jpeg"))).toBe("image/jpeg");
  });

  it("recognizes a real PNG by its magic bytes", async () => {
    expect(sniffImageMime(await realImageBuffer("png"))).toBe("image/png");
  });

  it("recognizes a real WebP by its magic bytes", async () => {
    expect(sniffImageMime(await realImageBuffer("webp"))).toBe("image/webp");
  });

  it("rejects plain text data even if it were named photo.jpg", () => {
    expect(sniffImageMime(Buffer.from("not an image, just text", "utf-8"))).toBeNull();
  });

  it("rejects SVG outright — never treated as an accepted image format (script-embedding risk)", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf-8");
    expect(sniffImageMime(svg)).toBeNull();
  });

  it("rejects an empty buffer", () => {
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe("validateRawUpload — the gate every upload path runs before any processing/storage", () => {
  it("accepts a real, reasonably-sized image", async () => {
    const buffer = await realImageBuffer("png");
    expect(() => validateRawUpload({ buffer, declaredSize: buffer.byteLength })).not.toThrow();
  });

  it("rejects a file over the 10MB cap even before inspecting its content", () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024);
    expect(() => validateRawUpload({ buffer: oversized, declaredSize: oversized.byteLength })).toThrow(ImageValidationError);
  });

  it("rejects non-image content that happens to be under the size cap", () => {
    const buffer = Buffer.from("definitely not an image", "utf-8");
    expect(() => validateRawUpload({ buffer, declaredSize: buffer.byteLength })).toThrow(ImageValidationError);
  });

  it("rejects when the declared size lies below the cap but the real buffer is over it (never trusts declaredSize alone)", () => {
    const buffer = Buffer.alloc(11 * 1024 * 1024);
    expect(() => validateRawUpload({ buffer, declaredSize: 100 })).toThrow(ImageValidationError);
  });
});
