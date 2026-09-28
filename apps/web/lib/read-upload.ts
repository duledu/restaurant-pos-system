import type { RawUpload } from "@rcs/domain/media/image-service";

/**
 * Reads the "file" field of a multipart/form-data request into the raw
 * bytes the image pipeline expects. Deliberately does NOT inspect the
 * browser-supplied File.type/name — packages/domain/media/image-service.ts
 * sniffs the real MIME from the bytes themselves.
 */
export async function readUploadedFile(request: Request): Promise<RawUpload> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new Error("Nedostaje fajl (\"file\") u zahtevu.");
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  return { buffer, declaredSize: file.size };
}
