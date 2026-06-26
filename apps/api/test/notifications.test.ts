import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestDb } from "./helpers";
import { sendApprovalMessage } from "../src/notifications/telegram";
import {
  listChannels,
  upsertChannel,
  deleteChannel,
  notifyDraftPending,
} from "../src/services/notifications";
import type { Db } from "../src/db";
import { eq } from "drizzle-orm";
import { approvalActionTokens, workspaces } from "../src/db/schema";
import type { Mailer } from "../src/mail/mailer";

describe("notifications", () => {
  let db: Db;
  const WS = "ws-1";

  beforeEach(() => {
    db = createTestDb();
    process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
    db.insert(workspaces).values({ id: WS, name: "Test WS", createdAt: Date.now(), updatedAt: Date.now() }).run();
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  describe("channel CRUD", () => {
    it("creates, updates, and deletes channels", () => {
      // Create
      const c1 = upsertChannel(db, WS, { type: "telegram", target: "12345", enabled: true });
      expect(c1.id).toBeDefined();
      expect(c1.type).toBe("telegram");

      const list1 = listChannels(db, WS);
      expect(list1).toHaveLength(1);

      // Update (upsert with same type/target updates enabled)
      const c2 = upsertChannel(db, WS, { type: "telegram", target: "12345", enabled: false });
      expect(c2.id).toBe(c1.id);
      expect(c2.enabled).toBe(false);

      const list2 = listChannels(db, WS);
      expect(list2).toHaveLength(1);
      expect(list2[0]!.enabled).toBe(false);

      // Delete
      deleteChannel(db, WS, c1.id);
      expect(listChannels(db, WS)).toHaveLength(0);
    });
  });

  describe("sendApprovalMessage (Telegram client)", () => {
    it("POSTs the correct payload", async () => {
      const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

      await sendApprovalMessage(
        fetcher,
        "chat-123",
        { id: "d1", taskType: "x_dm", channel: "x", content: "hello" },
        "tokenA",
        "tokenB",
      );

      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0] as any[];
      expect(url).toBe("https://api.telegram.org/bottest-bot-token/sendMessage");
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body);
      expect(body.chat_id).toBe("chat-123");
      expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe("approve:tokenA");
      expect(body.reply_markup.inline_keyboard[0][1].callback_data).toBe("reject:tokenB");
    });

    it("is a no-op if no bot token is set", async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      const fetcher = vi.fn();
      await sendApprovalMessage(
        fetcher,
        "chat-123",
        { id: "d1", taskType: "x_dm", channel: "x", content: "hello" },
        "tokenA",
        "tokenB",
      );
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe("notifyDraftPending", () => {
    it("fans out to enabled channels and swallows errors", async () => {
      upsertChannel(db, WS, { type: "telegram", target: "chat1", enabled: true });
      upsertChannel(db, WS, { type: "email", target: "founder@example.com", enabled: true });
      upsertChannel(db, WS, { type: "email", target: "off@example.com", enabled: false });

      const fetcher = vi.fn().mockRejectedValue(new Error("Network down"));
      const mailer: Mailer = { send: vi.fn().mockRejectedValue(new Error("SMTP down")) };

      await notifyDraftPending(db, mailer, fetcher, {
        id: "d1",
        workspaceId: WS,
        taskType: "linkedin_post",
        channel: "linkedin",
        content: "my draft",
      });

      // Both should have been called
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(mailer.send).toHaveBeenCalledTimes(1);

      // 4 tokens should be minted (2 for telegram, 2 for email)
      const tokens = db.select().from(approvalActionTokens).all();
      expect(tokens).toHaveLength(4);
    });
  });
});
