// MCP server tests: the read-only chain-data tools an AI agent gets.
// The server never touches a real network in tests — callTool's api() fetch is stubbed.
const test = require('node:test');
const assert = require('node:assert');

test('mcp-server: tools/list exposes the read-only chain tools', async () => {
  const { handle } = await import(require('node:path').join(__dirname, 'mcp-server.mjs'));
  const list = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.strictEqual(list.error, undefined);
  const names = list.result.tools.map((t) => t.name);
  for (const want of ['chain_overview', 'block', 'blocks', 'transaction', 'address', 'tokens', 'token', 'mempool', 'search', 'mining']) {
    assert.ok(names.includes(want), `tool ${want} is listed`);
  }
  assert.ok(list.result.tools.every((t) => typeof t.description === 'string' && t.description.length > 10), 'every tool has a real description');
});

test('mcp-server: initialize answers with server info, notifications get no reply', async () => {
  const { handle } = await import(require('node:path').join(__dirname, 'mcp-server.mjs'));
  const init = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {} } });
  assert.strictEqual(init.result.protocolVersion, '2024-11-05');
  assert.strictEqual(init.result.serverInfo.name, 'noid-scan');
  assert.deepStrictEqual(init.result.capabilities, { tools: {} });
  const notif = await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.strictEqual(notif, null, 'notifications never produce a response');
  const ping = await handle({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepStrictEqual(ping.result, {});
});

test('mcp-server: a tool call answers with text content and errors are isError, not crashes', async () => {
  const { handle } = await import(require('node:path').join(__dirname, 'mcp-server.mjs'));
  // Unknown tool -> isError content, never a thrown exception.
  const bad = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
  assert.strictEqual(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /no such tool/);
  // Address validation refuses garbage before any fetch.
  const addr = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'address', arguments: { address: 'o1bad' } } });
  assert.strictEqual(addr.result.isError, true);
  assert.match(addr.result.content[0].text, /o1/);
  // Unknown method -> JSON-RPC error, not isError content.
  const unknown = await handle({ jsonrpc: '2.0', id: 6, method: 'wat' });
  assert.strictEqual(unknown.error.code, -32601);
});

test('mcp-server: callTool passes query params through to the explorer API', async () => {
  const { callTool } = await import(require('node:path').join(__dirname, 'mcp-server.mjs'));
  let seen = null;
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    seen = { url: String(url), key: opts?.headers?.['x-api-key'] || null };
    return new Response(JSON.stringify({ ok: true, requested: String(url) }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const out = await callTool('blocks', { q: 'abc', limit: 7, before: 99, window: '24h' });
    assert.strictEqual(out.ok, true);
    assert.match(seen.url, /\/api\/blocks\?/);
    assert.match(seen.url, /q=abc/);
    assert.match(seen.url, /limit=7/);
    assert.match(seen.url, /before=99/);
    assert.match(seen.url, /window=24h/);
    assert.strictEqual(seen.key, null, 'no key is sent unless NO1D_API_KEY is set');
    // empty params must not be serialized
    const out2 = await callTool('blocks', { q: '', limit: undefined });
    assert.doesNotMatch(seen.url, /q=/);
  } finally {
    global.fetch = orig;
  }
});
