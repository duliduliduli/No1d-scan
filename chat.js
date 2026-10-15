// AI assistant on OpenRouter. The model never answers from memory: it calls the explorer's own
// routes as tools, so every number comes from the node.
const MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen3.5-flash-02-23';
const MAX_ROUNDS = 5; // tool-call rounds per question, bounds cost per question

const SYSTEM = `You are the assistant on NOID Scan, a block explorer for the Parano1d (NOID) proof-of-work blockchain.
Answer with real data only: call the tools, never guess or invent numbers. If a tool has no data, say so.
Numbers in tool results are already converted and formatted: fields ending in _noid are NOID amounts, and numbers given as strings with commas are exact.
Copy numbers exactly as written, digits and separators included. Never convert units, rescale, round differently or re-add separators yourself.
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
  fn('network_history', 'Hashrate (H/s), average block time (s), difficulty (expected hashes per block) and active slots over time, from every header since genesis.', { window: { type: 'string', enum: ['24h', '7d', '30d', 'all'] } }),
  fn('top_miners', 'Miner addresses ranked by blocks mined in a time window, with share of blocks.', { window: { type: 'string', enum: ['24h', '7d', '30d', 'all'] } }),
  fn('mempool', 'Pending transactions, fee floor and the current minimum fee for common transaction shapes.'),
  fn('market', 'NOID price, market cap, 24h volume, price changes (15m to 30d), all-time high, and the exchanges it trades on.'),
  fn('holders', 'Number of addresses holding NOID, concentration (top 10/100 share) and how the holder count changed over time.'),
  fn('rich_list', 'Top addresses by balance with share of supply.', { limit: { type: 'integer', description: '1-100, default 20' } }),
];

// The model only copies numbers, it never converts them: every μNOID amount becomes an exact NOID string (BigInt, no
// float loss) and large counts get their separators here. Keys that are identifiers or times stay raw.
const RAW = /height|hash|time|^ts$|^t$|_at$|^at$|index|id$|bits|created|updated|expires|first|since|bucket/i;
const MICRO = /^(value|balance|supply|top10|top100)$/;
function noidStr(v) {
  const m = BigInt(String(v).split('.')[0]), neg = m < 0n, a = neg ? -m : m;
  const frac = String(a % 1000000n).padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${(a / 1000000n).toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
}
function forModel(x, key = '') {
  if (Array.isArray(x)) return x.map((v) => forModel(v, key));
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      // Holders, rich list and slots carry μNOID under plain names (balance, supply, value, top10, top100).
      if ((/_micronoid$/.test(k) || MICRO.test(k)) && v != null && /^-?\d+(\.\d+)?$/.test(String(v))) out[k.replace(/_micronoid$/, '') + '_noid'] = noidStr(v);
      else out[k] = forModel(v, k);
    }
    return out;
  }
  if (typeof x === 'number' && Number.isInteger(x) && Math.abs(x) >= 10000 && !RAW.test(key)) return x.toLocaleString('en-US');
  return x;
}

// Some models (Qwen) put their private reasoning in the reply, ending with </think>; only show what comes after.
const clean = (text) => String(text ?? '').replace(/^[\s\S]*<\/think>/, '').replace(/<think>[\s\S]*$/, '').trim();

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
    network_history: async (a) => { const h = await routes.history('', p({ window: a.window || '7d' })); return { ...h, points: h.points.slice(-60) }; },
    top_miners: (a) => routes.miners('', p({ window: a.window || '24h' })),
    mempool: () => routes.mempool(),
    market: async () => { const r = await routes.price('', p({ window: '24h' })); return r && { now: r.now, markets: r.markets }; },
    holders: async () => { const h = await routes.holders('', p({ window: '30d' })); return { ...h, points: h.points.slice(-30) }; },
    rich_list: (a) => routes.richlist('', p({ limit: Math.min(a.limit ?? 20, 100) })),
  };

  async function call(messages) {
    const r = await fetch(`${process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1'}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(45_000),
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'x-title': 'NOID Scan' },
      body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, max_tokens: 800, reasoning: { exclude: true } }),
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
      if (!m.tool_calls?.length) return { reply: clean(m.content) || '(no answer)' };
      convo.push({ role: 'assistant', content: m.content ?? '', tool_calls: m.tool_calls });
      for (const tc of m.tool_calls) {
        let out;
        try {
          const f = run[tc.function?.name];
          out = f ? forModel(await f(JSON.parse(tc.function.arguments || '{}'))) : { error: 'unknown tool' };
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
module.exports.forModel = forModel;
