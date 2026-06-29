export interface NangoOAuthSession {
  token: string;
  nangoBaseUrl: string;
  integrationKey: string;
}

export interface NangoOAuthSuccess {
  providerConfigKey: string;
  connectionId: string;
  isPending?: boolean;
}

interface PopupWindow {
  closed?: boolean;
  location: string | Location;
  close?: () => void;
  document?: {
    open?: () => void;
    write?: (html: string) => void;
    close?: () => void;
  };
}

interface OAuthSocket {
  onmessage: ((event: { data: string }) => void) | null;
  onerror?: (() => void) | null;
  close: () => void;
}

interface NangoOAuthDeps {
  openWindow?: (url: string, target: string, features: string) => PopupWindow | null;
  createWebSocket?: (url: string) => OAuthSocket;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function oauthSessionErrorMessage(providerLabel: string, status: number, body: unknown): string {
  if (isRecord(body)) {
    const message = body.message;
    if (typeof message === "string" && message.trim()) return message;

    if (status === 402 && body.error === "upgrade_required" && body.key === "connectors") {
      const limit = typeof body.limit === "number" ? body.limit : null;
      if (limit !== null) {
        return `Your current plan allows ${limit} connector${limit === 1 ? "" : "s"}. Disconnect an existing integration or upgrade to connect ${providerLabel}.`;
      }
      return `Your current plan does not allow another connector. Disconnect an existing integration or upgrade to connect ${providerLabel}.`;
    }
  }

  return `API returned ${status}`;
}

function popupFeatures(): string {
  return [
    "width=500",
    "height=600",
    "scrollbars=yes",
    "resizable=yes",
    "status=no",
    "toolbar=no",
    "location=no",
    "copyhistory=no",
    "menubar=no",
    "directories=no",
  ].join(",");
}

function websocketUrlFor(host: string): string {
  const url = new URL("/", host);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function writePopupStatus(popup: PopupWindow, title: string, detail?: string): void {
  try {
    popup.document?.open?.();
    popup.document?.write?.(`<!doctype html>
<html>
  <head>
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #111827; }
      p { color: #4b5563; line-height: 1.5; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
  </body>
</html>`);
    popup.document?.close?.();
  } catch {
    // If the popup has already left about:blank, the opener may no longer be
    // allowed to touch its document. The main app still receives the error.
  }
}

/**
 * Starts the Nango OAuth popup before waiting for the server-side connect
 * session. Browsers can block popups opened after an awaited request, which is
 * exactly what made OAuth provider buttons appear inert.
 */
export async function authorizeNangoOAuth(
  loadSession: () => Promise<NangoOAuthSession>,
  deps: NangoOAuthDeps = {},
): Promise<NangoOAuthSuccess> {
  const openWindow = deps.openWindow ?? ((url, target, features) => window.open(url, target, features));
  const createWebSocket =
    deps.createWebSocket ?? ((url) => new WebSocket(url) as unknown as OAuthSocket);
  const popup = openWindow("", "_blank", popupFeatures());

  if (!popup || popup.closed || typeof popup.closed === "undefined") {
    throw new Error("The authorization popup was blocked by the browser.");
  }
  const popupWindow: PopupWindow = popup;
  writePopupStatus(popupWindow, "Opening authorization", "Waiting for the connector service...");

  let socket: OAuthSocket | undefined;
  let navigated = false;
  try {
    const session = await loadSession();
    const authUrl = new URL(`/oauth/connect/${session.integrationKey}`, session.nangoBaseUrl);
    authUrl.searchParams.set("connect_session_token", session.token);

    return await new Promise<NangoOAuthSuccess>((resolve, reject) => {
      const currentSocket = createWebSocket(websocketUrlFor(session.nangoBaseUrl));
      socket = currentSocket;
      currentSocket.onerror = () => {
        currentSocket.close();
        reject(new Error("Could not connect to Nango's authorization service."));
      };
      currentSocket.onmessage = (message) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(message.data) as Record<string, unknown>;
        } catch {
          reject(new Error("Nango returned an unreadable authorization message."));
          socket?.close();
          return;
        }

        if (data.message_type === "connection_ack") {
          const wsClientId = typeof data.ws_client_id === "string" ? data.ws_client_id : "";
          if (wsClientId) authUrl.searchParams.set("ws_client_id", wsClientId);
          navigated = true;
          popupWindow.location = authUrl.href;
          return;
        }

        if (data.message_type === "success") {
          currentSocket.close();
          resolve({
            providerConfigKey: String(data.provider_config_key ?? ""),
            connectionId: String(data.connection_id ?? ""),
            isPending: Boolean(data.is_pending),
          });
          return;
        }

        if (data.message_type === "error") {
          currentSocket.close();
          reject(new Error(String(data.error_desc || "Authorization failed.")));
        }
      };
    });
  } catch (err) {
    if (socket) socket.close();
    const message = err instanceof Error ? err.message : "Authorization could not start.";
    if (!navigated) writePopupStatus(popupWindow, "Authorization could not start", message);
    throw err;
  }
}
