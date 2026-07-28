import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, request } from "undici";
import { normalizeHostname } from "./destination";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeFetchResolver {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
}

export interface PinnedRequest {
  url: URL;
  address: ResolvedAddress;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  connectTimeoutMs: number;
}

export interface TransportBody extends AsyncIterable<Uint8Array> {
  destroy(error?: Error): void;
}

export interface TransportResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: TransportBody;
}

export interface SafeFetchTransport {
  request(input: PinnedRequest): Promise<TransportResponse>;
}

export class NodeSafeFetchResolver implements SafeFetchResolver {
  async resolve(hostname: string): Promise<ResolvedAddress[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => ({
      address,
      family: family as 4 | 6,
    }));
  }
}

class ClosingTransportBody implements TransportBody {
  private settled = false;

  constructor(
    private readonly body: TransportBody,
    private readonly dispatcher: Agent,
  ) {}

  destroy(error?: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.body.destroy(error);
    void this.dispatcher.destroy(error ?? null);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    try {
      for await (const chunk of this.body) yield chunk;
    } finally {
      if (!this.settled) {
        this.settled = true;
        await this.dispatcher.close();
      }
    }
  }
}

export class UndiciSafeFetchTransport implements SafeFetchTransport {
  async request(input: PinnedRequest): Promise<TransportResponse> {
    const hostname = normalizeHostname(input.url.hostname);
    const dispatcher = new Agent({
      connect: {
        timeout: input.connectTimeoutMs,
        servername: isIP(hostname) ? undefined : hostname,
        lookup: (_requestedHostname, options, callback) => {
          if (options.all) {
            callback(null, [input.address]);
            return;
          }
          callback(null, input.address.address, input.address.family);
        },
      },
      maxRedirections: 0,
    });

    try {
      const response = await request(input.url, {
        dispatcher,
        headers: input.headers,
        maxRedirections: 0,
        signal: input.signal,
      });
      return {
        status: response.statusCode,
        headers: response.headers,
        body: new ClosingTransportBody(response.body, dispatcher),
      };
    } catch (cause) {
      await dispatcher.destroy(cause instanceof Error ? cause : null);
      throw cause;
    }
  }
}
