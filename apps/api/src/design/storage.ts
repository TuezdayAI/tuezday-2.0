import { createHash, createHmac } from "node:crypto";

// Asset-storage boundary (Sprint 41 Part 3) — the one genuinely new piece of
// infrastructure the design layer needs: Instagram's Graph API and Meta's
// ad-image upload both require publicly fetchable URLs. Deliberately not a
// DAM: bytes in, public URL out, nothing else (no library UI, no folders).

export interface AssetStorage {
  put(bytes: Uint8Array, contentType: string): Promise<{ url: string }>;
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

type Fetcher = typeof fetch;

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/**
 * S3-compatible storage via one AWS-SigV4-signed PUT — works against R2, B2,
 * S3, or MinIO (pick the cheapest at deploy time). No SDK, same "one endpoint,
 * one body shape" posture as the LLM gateways. Keys are content-addressed
 * (design/<sha256>.<ext>) so re-renders of identical output dedupe naturally
 * and uploads are idempotent.
 */
export class S3AssetStorage implements AssetStorage {
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly accessKey: string | undefined;
  private readonly secretKey: string | undefined;
  private readonly publicBaseUrl: string;
  private readonly region: string;

  constructor(
    options?: {
      endpoint?: string;
      bucket?: string;
      accessKey?: string;
      secretKey?: string;
      publicBaseUrl?: string;
      region?: string;
    },
    private readonly fetcher: Fetcher = fetch,
    /** Injectable clock so tests can pin the SigV4 timestamp. */
    private readonly now: () => Date = () => new Date(),
  ) {
    this.endpoint = (options?.endpoint ?? process.env.ASSET_STORAGE_ENDPOINT?.trim() ?? "").replace(/\/$/, "");
    this.bucket = options?.bucket ?? process.env.ASSET_STORAGE_BUCKET?.trim() ?? "";
    this.accessKey = (options?.accessKey ?? process.env.ASSET_STORAGE_ACCESS_KEY)?.trim() || undefined;
    this.secretKey = (options?.secretKey ?? process.env.ASSET_STORAGE_SECRET_KEY)?.trim() || undefined;
    this.publicBaseUrl = (options?.publicBaseUrl ?? process.env.ASSET_STORAGE_PUBLIC_BASE_URL?.trim() ?? "").replace(/\/$/, "");
    this.region = (options?.region ?? process.env.ASSET_STORAGE_REGION?.trim()) || "auto";
  }

  async put(bytes: Uint8Array, contentType: string): Promise<{ url: string }> {
    if (!this.endpoint || !this.bucket || !this.accessKey || !this.secretKey || !this.publicBaseUrl) {
      throw new StorageError(
        "Asset storage is not configured. Set ASSET_STORAGE_ENDPOINT, ASSET_STORAGE_BUCKET, ASSET_STORAGE_ACCESS_KEY, ASSET_STORAGE_SECRET_KEY and ASSET_STORAGE_PUBLIC_BASE_URL.",
      );
    }

    const extension = CONTENT_TYPE_EXTENSIONS[contentType] ?? "bin";
    const payloadHash = sha256Hex(bytes);
    const key = `design/${payloadHash}.${extension}`;

    const url = new URL(`${this.endpoint}/${this.bucket}/${key}`);
    const date = this.now();
    const amzDate = date.toISOString().replace(/[-:]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
    const shortDate = amzDate.slice(0, 8);

    // AWS Signature Version 4, single-chunk PUT.
    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${url.host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      "PUT",
      url.pathname,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${shortDate}/${this.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secretKey}`, shortDate), this.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    let res: Response;
    try {
      res = await this.fetcher(url.toString(), {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          "x-amz-content-sha256": payloadHash,
          "x-amz-date": amzDate,
          Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        body: bytes,
      });
    } catch (err) {
      throw new StorageError(
        `Could not reach asset storage: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new StorageError(
        `Asset storage returned ${res.status}: ${body.slice(0, 300) || "no body"}`,
      );
    }

    return { url: `${this.publicBaseUrl}/${key}` };
  }
}
