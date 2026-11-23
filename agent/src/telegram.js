// A small Telegram Bot API client using long polling: the bot asks Telegram for
// new messages, so the server needs no public webhook. Every user is served in a
// private chat (their chat id is their user id), with a per-user rate limit.

export function createTelegram({ token, fetchImpl = fetch, log = console }) {
  const base = `https://api.telegram.org/bot${token}`;

  async function call(method, body, timeoutMs = 30_000) {
    const response = await fetchImpl(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || response.status}`);
    return data.result;
  }

  async function send(chatId, { text, link }) {
    const body = { chat_id: chatId, text: text.slice(0, 4000), link_preview_options: { is_disabled: true } };
    if (link) {
      body.reply_markup = { inline_keyboard: [[{ text: link.label, url: link.url }]] };
      // Also as text, so it can be copied and pasted into the QoreX browser.
      body.text = `${body.text}\n\nLink (open it in the QoreX browser):\n${link.url}`.slice(0, 4000);
    }
    return call("sendMessage", body);
  }

  async function poll({ onMessage, signal, perMinute = 12 }) {
    let offset = 0;
    const recent = new Map(); // userId -> timestamps of recent messages
    const limited = (userId) => {
      const now = Date.now();
      const times = (recent.get(userId) || []).filter((t) => now - t < 60_000);
      times.push(now);
      recent.set(userId, times);
      return times.length > perMinute;
    };
    while (!signal?.aborted) {
      let updates;
      try {
        updates = await call("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, 60_000);
      } catch (error) {
        if (signal?.aborted) return;
        log.warn?.("[telegram] poll failed:", error.message);
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message?.text || message.chat?.type !== "private" || !message.from?.id || message.from.is_bot) continue;
        const userId = String(message.from.id);
        if (limited(userId)) continue;
        // Handle users concurrently: one user's slow payment does not hold up the others.
        Promise.resolve()
          .then(() => onMessage(userId, message.text))
          .then((reply) => send(message.chat.id, reply))
          .catch(async (error) => {
            log.error?.("[telegram] handling failed:", error.shortMessage || error.message);
            await send(message.chat.id, { text: "Something went wrong talking to the chain. Try again in a moment." }).catch(() => {});
          });
      }
    }
  }

  return { send, poll };
}
