/**
 * MediaStorage — the one abstraction the rest of image-service.ts talks to.
 * R2MediaStorage is the sole implementation (Cloudflare R2, S3-compatible
 * API via @aws-sdk/client-s3). Kept deliberately small: put/delete/publicUrl,
 * nothing else — no generic bucket-browsing, no presigned-upload API, no
 * feature this codebase doesn't actually use yet.
 */
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getR2Config, type R2Config } from "./r2-config";

export interface MediaStorage {
  put(key: string, buffer: Buffer, contentType: string): Promise<string>;
  delete(url: string): Promise<void>;
  publicUrl(key: string): string;
}

/**
 * Pure — true only if `url` was issued under OUR configured public base URL.
 * This is what makes "never delete an arbitrary external URL" enforceable:
 * a legacy Vercel Blob URL, a competitor's CDN link, anything that isn't
 * exactly `${publicBaseUrl}/<key>` returns null and the caller no-ops.
 * Exported for direct unit testing (no S3 client, no network).
 */
export function keyFromOwnedUrl(url: string, publicBaseUrl: string): string | null {
  const prefix = `${publicBaseUrl}/`;
  if (!url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length);
  return key.length > 0 ? key : null;
}

// One S3Client per unique endpoint+credentials — cheap to reuse, expensive
// (a real TLS/connection setup cost) to recreate per request.
const clientCache = new Map<string, S3Client>();
function s3ClientFor(config: R2Config): S3Client {
  const cacheKey = `${config.endpoint}:${config.accessKeyId}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    clientCache.set(cacheKey, client);
  }
  return client;
}

export class R2MediaStorage implements MediaStorage {
  private readonly config: R2Config;

  /** Config is read lazily (getR2Config() throws a clean, secret-free error if unset) — never at import time. Accepts an injected config for tests. */
  constructor(config?: R2Config) {
    this.config = config ?? getR2Config();
  }

  publicUrl(key: string): string {
    return `${this.config.publicBaseUrl}/${key}`;
  }

  async put(key: string, buffer: Buffer, contentType: string): Promise<string> {
    await s3ClientFor(this.config).send(
      new PutObjectCommand({ Bucket: this.config.bucketName, Key: key, Body: buffer, ContentType: contentType })
    );
    return this.publicUrl(key);
  }

  async delete(url: string): Promise<void> {
    const key = keyFromOwnedUrl(url, this.config.publicBaseUrl);
    if (!key) return; // not ours (legacy Blob URL, external URL, anything else) — never attempt to delete it
    await s3ClientFor(this.config).send(new DeleteObjectCommand({ Bucket: this.config.bucketName, Key: key }));
  }
}
