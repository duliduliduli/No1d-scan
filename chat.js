// AI assistant on OpenRouter. The model never answers from memory: it calls the explorer's own
// routes as tools, so every number comes from the node.
const MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen3.5-flash-02-23';
const MAX_ROUNDS = 5; // tool-call rounds per question, bounds cost per question

const SYSTEM = `You are the assistant on NOID Scan, a block explorer for the Parano1d (NOID) proof-of-work blockchain.
Answer with real data only: call the tools, never guess or invent numbers. If a tool has no data, say so.
Amount fields ending in _micronoid are in μNOID (1 NOID = 1,000,000 μNOID); show NOID to the user.
Timestamps are unix seconds. Block bodies (transactions) are kept only for about the last 42 blocks; headers are permanent.
Be concise: short sentences, numbers formatted with separators, bullet points for lists.`;

const fn = (name, description, properties = {}, required = []) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const TOOLS = [
  fn('chain_stats', 'Current chain, state, mining and node stats: height, supply, difficulty, block reward, active slots, peers.'),
  fn('latest_blocks', 'Block headers, newest first.', { limit: { type: 'integer', description: '1-50, default 10' }, before: { type: 'integer', description: 'start at this height' } }),
  fn('block', 'One block by height or 64-hex hash, with its body if still retained.', { id: { type: 'string' } }, ['id']),
  fn('transaction', 'One transaction by 64-hex txid.', { txid: { type: 'string' } }, ['txid']),
  fn('address', 'Balance, live slots and recent activity of an o1… address.', { address: { type: 'string' } }, ['address']),
  fn('recent_transactions', 'Most recent transactions across the chain.'),
  fn('history', 'Per-block history of difficulty, active slots, supply and peers, for trends.'),
];

module.exports = function chat(routes) {
  const KEY = process.env.OPENROUTER_API_KEY;
  const p = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  const run = {
    chain_stats: () => routes.stats(),
    latest_blocks: (a) => routes.blocks('', p({ limit: Math.min(a.limit ?? 10, 50), before: a.before })),
    block: (a) => routes.block(String(a.id)),
    transaction: (a) => routes.tx(String(a.txid)),
    address: (a) => routes.address(String(a.address), p({})),
    recent_transactions: () => routes.txs('', p({})),
    history: async () => (await routes.charts()).slice(-60),
  };

  async function call(messages) {
    const r = await fetch(`${process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1'}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(45_000),
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'x-title': 'NOID Scan' },
      body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, max_tokens: 800 }),
    });
    const j = await r.json();
    if (!r.ok || !j.choices?.[0]) throw Object.assign(new Error(`AI unavailable: ${j.error?.message || r.status}`), { status: 502 });
    return j.choices[0].message;
  }

  // history: [{role: 'user'|'assistant', content}] from the browser; validated here (trust boundary).
  async function ask(history) {
    if (!KEY) throw Object.assign(new Error('the AI assistant is not enabled on this explorer'), { status: 404 });
    if (!Array.isArray(history) || !history.length) throw Object.assign(new Error('expected a non-empty messages array'), { status: 400 });
    const msgs = history.slice(-10).map((m) => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      content: String(m?.content ?? '').slice(0, 2000),
    }));
    if (msgs.at(-1).role !== 'user' || !msgs.at(-1).content.trim()) throw Object.assign(new Error('last message must be your question'), { status: 400 });

    const convo = [{ role: 'system', content: SYSTEM }, ...msgs];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const m = await call(convo);
      if (!m.tool_calls?.length) return { reply: m.content || '(no answer)' };
      convo.push({ role: 'assistant', content: m.content ?? '', tool_calls: m.tool_calls });
      for (const tc of m.tool_calls) {
        let out;
        try {
          const f = run[tc.function?.name];
          out = f ? await f(JSON.parse(tc.function.arguments || '{}')) : { error: 'unknown tool' };
        } catch (e) {
          out = { error: e.message };
        }
        convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out ?? { error: 'not found' }).slice(0, 8000) });
      }
    }
    return { reply: 'That needed too many lookups. Try a narrower question.' };
  }

  return { ask, enabled: !!KEY, model: MODEL };
};
