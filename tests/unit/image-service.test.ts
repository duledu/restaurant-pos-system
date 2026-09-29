import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { sniffImageMime, validateRawUpload, processImage, ImageValidationError } from "../../packages/domain/media/image-service";

async function realImageBuffer(format: "jpeg" | "png" | "webp", width = 4, height = 4): Promise<Buffer> {
  const image = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } });
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

describe("processImage — per-role resize/format pipeline (real sharp transforms, no mocks)", () => {
  it("MENU_ITEM_IMAGE never exceeds 512×512", async () => {
    const source = await realImageBuffer("jpeg", 2000, 2000);
    const output = await processImage(source, "MENU_ITEM_IMAGE");
    const meta = await sharp(output).metadata();
    expect(meta.width).toBeLessThanOrEqual(512);
    expect(meta.height).toBeLessThanOrEqual(512);
  });

  it("MENU_ITEM_IMAGE output is WebP", async () => {
    const source = await realImageBuffer("png", 300, 300);
    const output = await processImage(source, "MENU_ITEM_IMAGE");
    expect((await sharp(output).metadata()).format).toBe("webp");
  });

  it("does not enlarge a smaller-than-target source (withoutEnlargement)", async () => {
    const source = await realImageBuffer("jpeg", 100, 80);
    const output = await processImage(source, "MENU_ITEM_IMAGE");
    const meta = await sharp(output).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(80);
  });

  it("QR_HERO_IMAGE never exceeds 1920×1080", async () => {
    const source = await realImageBuffer("jpeg", 4000, 2200);
    const output = await processImage(source, "QR_HERO_IMAGE");
    const meta = await sharp(output).metadata();
    expect(meta.width).toBeLessThanOrEqual(1920);
    expect(meta.height).toBeLessThanOrEqual(1080);
    expect(meta.format).toBe("webp");
  });

  it("RESTAURANT_LOGO never exceeds 512×512 and outputs PNG", async () => {
    const source = await realImageBuffer("png", 1500, 1500);
    const output = await processImage(source, "RESTAURANT_LOGO");
    const meta = await sharp(output).metadata();
    expect(meta.width).toBeLessThanOrEqual(512);
    expect(meta.height).toBeLessThanOrEqual(512);
    expect(meta.format).toBe("png");
  });

  it("RESTAURANT_LOGO preserves transparency", async () => {
    const source = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0 } } }).png().toBuffer();
    const output = await processImage(source, "RESTAURANT_LOGO");
    const meta = await sharp(output).metadata();
    expect(meta.hasAlpha).toBe(true);
    // Sample a pixel — the source was fully transparent, so the output must still be (not flattened onto a background color).
    const { data, info } = await sharp(output).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBe(0); // alpha channel of the first pixel
  });

  it("auto-orients from EXIF and strips the orientation tag from the output", async () => {
    // A 100×50 (wide) source tagged "orientation: 6" (rotate 90° CW to display correctly)
    // must come out physically rotated (~50×100) with no orientation tag left to reinterpret.
    const wide = await sharp({ create: { width: 100, height: 50, channels: 3, background: { r: 50, g: 60, b: 70 } } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const output = await processImage(wide, "MENU_ITEM_IMAGE");
    const meta = await sharp(output).metadata();
    expect(meta.orientation).toBeUndefined();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(100);
  });

  it("accepts JPEG, PNG, and WebP as input regardless of output format", async () => {
    for (const format of ["jpeg", "png", "webp"] as const) {
      const source = await realImageBuffer(format, 40, 40);
      const output = await processImage(source, "MENU_ITEM_IMAGE");
      expect((await sharp(output).metadata()).format).toBe("webp");
    }
  });

  it("rejects corrupted/truncated data even when it superficially looks like an image", async () => {
    const real = await realImageBuffer("jpeg");
    const truncated = real.subarray(0, Math.floor(real.byteLength / 3));
    await expect(processImage(truncated, "MENU_ITEM_IMAGE")).rejects.toThrow(ImageValidationError);
  });
});
