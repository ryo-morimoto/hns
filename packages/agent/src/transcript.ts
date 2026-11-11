import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

/**
 * The text of the newest assistant entry that says something, which answers a turn.
 *
 * @remarks
 * Reads the newest 200 entries and sorts them by id, so it relies on neither the
 * page order nor the model ending with text; a turn of only tool calls yields "".
 */
export async function lastAssistantText(
  conversation: Conversation,
  context: Context,
): Promise<string> {
  const page = await conversation.entries({}, 200, undefined, context);
  const newestFirst = [...page.items].sort((left, right) => Number(right.id) - Number(left.id));
  for (const entry of newestFirst) {
    if (entry.kind !== "pi.assistant") continue;
    const text = textOf(entry);
    if (text !== "") return text;
  }
  return "";
}

/**
 * Concatenate the text parts of one entry's model message.
 *
 * @remarks
 * Durable stores content as text or as parts; non-text parts contribute nothing,
 * and an entry with no model message contributes "". That is why an assistant
 * entry which only calls a tool reads as empty.
 */
function textOf(entry: EntryRecord): string {
  const message = entry.model?.[0];
  if (message === undefined) return "";
  const content = message.content;
  if (!Array.isArray(content)) return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
