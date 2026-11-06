/**
 * Finds the JSON answer in an agent reply: the last ```json fenced block, else the last fenced block that parses,
 * else the whole reply when it is bare JSON. Returns undefined when there is none.
 */
export function extractJson(reply: string): unknown {
  const blocks = [...reply.matchAll(/```([a-zA-Z]*)[^\n]*\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1].toLowerCase(), body: m[2] }));
  const ordered = [...blocks.filter((b) => b.lang === 'json').reverse(), ...blocks.filter((b) => b.lang !== 'json').reverse()];
  for (const b of ordered) {
    try {
      return JSON.parse(b.body);
    } catch {
      // try the next block
    }
  }
  const trimmed = reply.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
