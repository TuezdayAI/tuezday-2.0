import { describe, expect, it, vi } from "vitest";

import { authorizeNangoOAuth, oauthSessionErrorMessage } from "./nango-oauth";

describe("authorizeNangoOAuth", () => {
  it("formats connector entitlement failures without exposing the raw 402 status", () => {
    expect(
      oauthSessionErrorMessage("X", 402, {
        error: "upgrade_required",
        key: "connectors",
        limit: 1,
      }),
    ).toBe(
      "Your current plan allows 1 connector. Disconnect an existing integration or upgrade to connect X.",
    );
  });

  it("opens the popup before waiting for the session token, then navigates through Nango", async () => {
    let resolveSession:
      | ((session: { token: string; nangoBaseUrl: string; integrationKey: string }) => void)
      | undefined;
    const sessionPromise = new Promise<{ token: string; nangoBaseUrl: string; integrationKey: string }>(
      (resolve) => {
        resolveSession = resolve;
      },
    );
    const popup = { closed: false, location: "", close: vi.fn() };
    const events: string[] = [];
    const sockets: Array<{ onmessage: ((event: { data: string }) => void) | null; close: () => void }> = [];

    const authPromise = authorizeNangoOAuth(
      () => {
        events.push("load-session");
        return sessionPromise;
      },
      {
      openWindow: (url) => {
        events.push(`open:${url}`);
        return popup;
      },
      createWebSocket: (url) => {
        events.push(`socket:${url}`);
        const socket = { onmessage: null, close: vi.fn() };
        sockets.push(socket);
        return socket;
      },
      },
    );

    expect(events).toEqual(["open:", "load-session"]);

    resolveSession?.({
      token: "session-token",
      nangoBaseUrl: "http://localhost:3050",
      integrationKey: "tuezday-twitter",
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    sockets[0]!.onmessage?.({
      data: JSON.stringify({ message_type: "connection_ack", ws_client_id: "ws-123" }),
    });

    expect(popup.location).toBe(
      "http://localhost:3050/oauth/connect/tuezday-twitter?connect_session_token=session-token&ws_client_id=ws-123",
    );

    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        message_type: "success",
        provider_config_key: "tuezday-twitter",
        connection_id: "nango-connection",
        is_pending: false,
      }),
    });

    await expect(authPromise).resolves.toEqual({
      providerConfigKey: "tuezday-twitter",
      connectionId: "nango-connection",
      isPending: false,
    });
    expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("shows the startup error in the popup instead of closing it immediately", async () => {
    const writes: string[] = [];
    const popup = {
      closed: false,
      location: "",
      close: vi.fn(),
      document: {
        open: vi.fn(),
        write: vi.fn((html: string) => writes.push(html)),
        close: vi.fn(),
      },
    };

    await expect(
      authorizeNangoOAuth(
        async () => {
          throw new Error("Plan limit reached for connectors.");
        },
        {
          openWindow: () => popup,
          createWebSocket: () => {
            throw new Error("socket should not open");
          },
        },
      ),
    ).rejects.toThrow("Plan limit reached for connectors.");

    expect(popup.close).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("Plan limit reached for connectors.");
  });

  it("does not close the popup when Nango returns an authorization error after navigation", async () => {
    const popup = { closed: false, location: "", close: vi.fn() };
    const socket: { onmessage: ((event: { data: string }) => void) | null; close: () => void } = {
      onmessage: null,
      close: vi.fn(),
    };

    const authPromise = authorizeNangoOAuth(
      async () => ({
        token: "session-token",
        nangoBaseUrl: "http://localhost:3050",
        integrationKey: "tuezday-twitter",
      }),
      {
        openWindow: () => popup,
        createWebSocket: () => socket,
      },
    );

    await vi.waitFor(() => expect(socket.onmessage).toBeTruthy());
    socket.onmessage?.({
      data: JSON.stringify({ message_type: "connection_ack", ws_client_id: "ws-123" }),
    });
    socket.onmessage?.({
      data: JSON.stringify({ message_type: "error", error_desc: "OAuth app rejected the request." }),
    });

    await expect(authPromise).rejects.toThrow("OAuth app rejected the request.");
    expect(popup.close).not.toHaveBeenCalled();
  });
});
