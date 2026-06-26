// Telegram Bot REST client (Sprint 39)
// No SDK used, just pure fetch.

export class TelegramError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "TelegramError";
  }
}

function getBotToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN;
}

export async function sendApprovalMessage(
  fetcher: typeof fetch,
  chatId: string,
  draft: {
    id: string;
    taskType: string;
    channel: string;
    content: string;
  },
  approveToken: string,
  rejectToken: string,
): Promise<void> {
  const token = getBotToken();
  if (!token) return; // Unconfigured bot -> no-op

  const text = `*New Draft Pending Approval*\n\n*Task:* ${draft.taskType}\n*Channel:* ${draft.channel}\n\n*Content:*\n${draft.content}`;

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve:${approveToken}` },
          { text: "❌ Reject", callback_data: `reject:${rejectToken}` },
        ],
      ],
    },
  };

  try {
    const res = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new TelegramError(`Telegram API error: ${body}`, res.status);
    }
  } catch (err) {
    if (err instanceof TelegramError) throw err;
    throw new TelegramError(`Network error: ${(err as Error).message}`);
  }
}

export async function answerCallback(
  fetcher: typeof fetch,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  const token = getBotToken();
  if (!token) return;

  const payload = {
    callback_query_id: callbackQueryId,
    text,
  };

  try {
    const res = await fetcher(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new TelegramError(`Telegram API error: ${body}`, res.status);
    }
  } catch (err) {
    if (err instanceof TelegramError) throw err;
    throw new TelegramError(`Network error: ${(err as Error).message}`);
  }
}
