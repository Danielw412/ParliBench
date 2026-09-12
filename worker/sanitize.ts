// Display text is plain text/Markdown rendered without raw HTML, links, or remote media.
// Automated cleanup is a floor: an admin must also remove semantic identity clues offline.
export function sanitizeDisplay(input: string): string {
  return input
    .replace(/<(script|style|tool_call|tool_result|thinking|analysis|metadata)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/^\s*(?:#{1,6}\s*)?(?:sources|references|citations|tool (?:calls|results|traces)|metadata)\s*:?[\s\S]*$/gim, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s)<>]+/gi, '')
    .replace(/\[\^?\d+(?:[,–-]\d+)*\]/g, '')
    .replace(/\uE200[\s\S]*?\uE201/g, '')
    .replace(/【[^】]*(?:†|source|turn\d)[^】]*】/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/^.*\b(?:as an ai|i am (?:claude|chatgpt|gemini)|model\s*:|provider\s*:|tool[_ ](?:call|result)|web\.run|search_query)\b.*$/gim, '')
    .trim();
}
export function validateBlindText(text: string, identities: string[]): string {
  const clean = sanitizeDisplay(text);
  if (!clean) throw new Error('Display output is empty after sanitization');
  // Match complete identifying phrases, avoiding substrings in ordinary words.
  for (const identity of identities.filter(s => s.trim().length >= 3)) {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|\\W)${escaped}(?:$|\\W)`, 'i').test(clean)) throw new Error('Display output contains a system identity. Remove it before import.');
  }
  return clean;
}
