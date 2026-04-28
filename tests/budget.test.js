/**
 * Mock unit tests for hive-mcp-openclaw-bridge.
 * Exercises Layer 1 budget + door_subscribe lifecycle without hitting
 * the real Hive Gamification backend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch BEFORE importing the server so the module-level fetch refs use it.
const fetchCalls = [];
let fetchResponder = null;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), method: init?.method || 'GET', body: init?.body });
  if (!fetchResponder) {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const r = fetchResponder({ url: String(url), method: init?.method || 'GET', body: init?.body });
  return new Response(JSON.stringify(r.body ?? {}), {
    status: r.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
};

const { _internal } = await import('../server.js');
const { budget, atomicReserve, settle, release, headroom, executeTool, DOORS } = _internal;

function reset() {
  budget.spent.clear();
  budget.reserved.clear();
  budget.reservations.clear();
  budget.seq = 0;
  for (const lvl of ['namespace', 'user', 'agent', 'task']) budget.caps[lvl] = {};
  fetchCalls.length = 0;
  fetchResponder = null;
}

test('atomicReserve succeeds within caps', () => {
  reset();
  budget.caps.namespace.ns1 = 10;
  budget.caps.user['did:hive:a'] = 1;
  const r = atomicReserve({
    scope: { namespace: 'ns1', user: 'did:hive:a' },
    amount: '0.50', asset: 'USDC',
  });
  assert.equal(r.ok, true);
  assert.ok(r.reservationId);
  assert.equal(headroom('user', 'did:hive:a'), 0.5);
});

test('atomicReserve rejects when most-restrictive level is short', () => {
  reset();
  budget.caps.namespace.ns1 = 100;
  budget.caps.task.t1 = 0.05;
  const r = atomicReserve({
    scope: { namespace: 'ns1', task: 't1' },
    amount: '0.10', asset: 'USDC',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /task:t1/);
  // Atomic — no holds taken.
  assert.equal(headroom('namespace', 'ns1'), 100);
});

test('settle records spend, release does not', () => {
  reset();
  budget.caps.user.u = 2;
  const r1 = atomicReserve({ scope: { user: 'u' }, amount: '0.30', asset: 'USDC' });
  settle(r1.reservationId);
  assert.equal(budget.spent.get('user:u'), 0.30);
  assert.equal(budget.reserved.get('user:u'), 0);

  const r2 = atomicReserve({ scope: { user: 'u' }, amount: '0.50', asset: 'USDC' });
  release(r2.reservationId);
  assert.equal(budget.spent.get('user:u'), 0.30);
  assert.equal(budget.reserved.get('user:u'), 0);
});

test('door_subscribe → reserve → upstream POST 2xx → settle', async () => {
  reset();
  budget.caps.namespace.ns1 = 100;
  budget.caps.task.t1 = 1.0;
  fetchResponder = ({ url, method }) => {
    if (method === 'POST' && url.endsWith('/v1/debt/subscribe')) {
      return { status: 200, body: { ok: true, subscription_id: 'sub_1' } };
    }
    return { status: 404, body: { err: 'unexpected' } };
  };
  const out = await executeTool('door_subscribe', {
    door_id: 'computational-debt',
    did: 'did:hive:test',
    scope: { namespace: 'ns1', task: 't1' },
  });
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.door_id, 'computational-debt');
  assert.equal(parsed.price, DOORS['computational-debt'].price);
  assert.equal(parsed.upstream.status, 200);
  // 0.50 settled at both levels.
  assert.equal(budget.spent.get('namespace:ns1'), 0.50);
  assert.equal(budget.spent.get('task:t1'), 0.50);
  assert.equal(budget.reserved.get('task:t1'), 0);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/v1\/debt\/subscribe$/);
});

test('door_subscribe → upstream non-2xx → reservation released', async () => {
  reset();
  budget.caps.task.t = 1.0;
  fetchResponder = () => ({ status: 503, body: { err: 'down' } });
  const out = await executeTool('door_subscribe', {
    door_id: 'capability-leasing',
    did: 'did:hive:test',
    scope: { task: 't' },
  });
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.upstream.status, 503);
  assert.equal(budget.spent.get('task:t') || 0, 0);
  assert.equal(budget.reserved.get('task:t') || 0, 0);
});

test('door_subscribe → budget exceeded → no upstream call made', async () => {
  reset();
  budget.caps.task.t = 0.05;  // smaller than computational-debt price 0.50
  fetchCalls.length = 0;
  const out = await executeTool('door_subscribe', {
    door_id: 'computational-debt',
    did: 'did:hive:test',
    scope: { task: 't' },
  });
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.blocked_by, 'layer1_budget');
  assert.equal(fetchCalls.length, 0);
});

test('budget_check is read-only', async () => {
  reset();
  budget.caps.user.u = 1;
  const out = await executeTool('budget_check', {
    scope: { user: 'u' }, amount: '0.50', asset: 'USDC',
  });
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.ok, true);
  assert.equal(budget.reserved.get('user:u') || 0, 0);
});

test('budget_set_cap overrides default at one level/key', async () => {
  reset();
  await executeTool('budget_set_cap', { level: 'agent', key: 'ag1', cap: 0.10 });
  assert.equal(budget.caps.agent.ag1, 0.10);
  // Reserve 0.05 should pass; 0.20 should fail.
  const r1 = atomicReserve({ scope: { agent: 'ag1' }, amount: '0.05', asset: 'USDC' });
  assert.equal(r1.ok, true);
  settle(r1.reservationId);
  const r2 = atomicReserve({ scope: { agent: 'ag1' }, amount: '0.20', asset: 'USDC' });
  assert.equal(r2.ok, false);
});

test('doors_list returns 8 doors with pricing', async () => {
  reset();
  const out = await executeTool('doors_list', {});
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.count, 8);
  assert.equal(parsed.doors.length, 8);
  for (const d of parsed.doors) {
    assert.ok(d.id);
    assert.ok(d.endpoint.startsWith('/'));
    assert.ok(typeof d.price === 'number');
    assert.equal(d.asset, 'USDC');
  }
});

test('bogo_claim hits /v1/bogo/claim with mechanic_id + did', async () => {
  reset();
  fetchResponder = ({ url, method, body }) => {
    if (method === 'POST' && url.endsWith('/v1/bogo/claim')) {
      const parsed = JSON.parse(body);
      return { status: 200, body: { granted: true, mechanic_id: parsed.mechanic_id } };
    }
    return { status: 404, body: {} };
  };
  const out = await executeTool('bogo_claim', {
    door_id: 'pheromone-priority',
    did: 'did:hive:test',
  });
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.door_id, 'pheromone-priority');
  assert.equal(parsed.status, 200);
});

test('unknown tool throws', async () => {
  reset();
  await assert.rejects(() => executeTool('nope', {}), /Unknown tool/);
});
