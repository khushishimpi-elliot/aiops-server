function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('\n');
}

export function parseSession(rawLines) {
  const messages = [];
  let model = null;
  let firstTs = null;
  let lastTs = null;

  for (const entry of rawLines) {
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : null;
    if (ts) {
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
    }

    if (entry.type === 'user') {
      const msg = entry.message ?? entry;
      const content = extractText(msg.content ?? '');
      if (content) messages.push({ role: 'user', content });
    } else if (entry.type === 'assistant') {
      const msg = entry.message ?? entry;
      const content = extractText(msg.content ?? '');
      const usage = msg.usage ?? null;
      const entryModel = msg.model ?? null;
      if (entryModel && !model) model = entryModel;
      messages.push({ role: 'assistant', content, model: entryModel, usage });
    }
  }

  return { messages, model, firstTs, lastTs };
}
