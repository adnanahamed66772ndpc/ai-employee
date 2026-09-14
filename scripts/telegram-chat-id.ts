/**
 * Finds the chat id for Telegram notifications.
 *
 *   1. Create a bot with @BotFather and put its token in .env.local as AI_EMPLOYEE_TELEGRAM_BOT_TOKEN
 *   2. Send any message to the bot from your Telegram account
 *   3. npm run telegram:chat-id
 */
const token = process.env.AI_EMPLOYEE_TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("AI_EMPLOYEE_TELEGRAM_BOT_TOKEN is not set in .env.local");
  process.exit(1);
}

interface Update {
  message?: { chat: { id: number; type: string; title?: string; username?: string; first_name?: string } };
}

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`).catch((error: Error) => {
  console.error(`Could not reach Telegram: ${error.message.split(token).join("***")}`);
  process.exit(1);
});
const body = (await res.json()) as { ok: boolean; description?: string; result?: Update[] };
if (!body.ok) {
  console.error(`Telegram refused the request: ${body.description ?? `HTTP ${res.status}`}`);
  process.exit(1);
}

const chats = new Map<number, string>();
for (const update of body.result ?? []) {
  const chat = update.message?.chat;
  if (chat) chats.set(chat.id, chat.title ?? chat.username ?? chat.first_name ?? chat.type);
}
if (chats.size === 0) {
  console.log("No messages yet. Send any message to your bot in Telegram, then run this again.");
} else {
  for (const [id, name] of chats) console.log(`${name}: AI_EMPLOYEE_TELEGRAM_CHAT_ID=${id}`);
  console.log("\nAdd the line for your chat to .env.local and restart the server.");
}
