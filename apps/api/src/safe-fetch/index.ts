import type { SafeFetchLimits, SafeFetchProfile } from "./policy";

export * from "./destination";
export * from "./body";
export * from "./errors";
export * from "./policy";
export * from "./service";
export * from "./transport";

export interface SafeFetchRequest {
  url: string;
  profile: SafeFetchProfile;
  headers?: Readonly<Record<string, string>>;
  limits?: Partial<
    Pick<SafeFetchLimits, "maxCompressedBytes" | "maxDecodedBytes">
  >;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
}

export interface SafeFetchService {
  validateUrl(url: string): URL;
  fetch(request: SafeFetchRequest): Promise<SafeFetchResult>;
}
