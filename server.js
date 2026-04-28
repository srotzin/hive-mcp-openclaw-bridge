#!/usr/bin/env node
/**
 * hive-mcp-openclaw-bridge
 *
 * Reference integration with @kinthaiofficial's OpenClaw 3-layer payment
 * governance framework, wrapping Hive Gamification's 8 BOGO doors behind a
 * 4-level hierarchical budget (Namespace → User → Agent → Task) before
 * any external x402 settlement is signed.
 *
 *   Layer 1  internal hierarchical budget (this server) — atomic reserve/settle
 *   Layer 2  millicent-style epoch ledger (OpenClaw)    — out of scope here
 *   Layer 3  external x402                               — Hive Gamification
 *
 * Backend : https://hive-gamification.onrender.com
 * Spec    : MCP 2024-11-05 / Streamable-HTTP / JSON-RPC 2.0
 * Brand   : Hive Civilization gold #C08D23 (Pantone 1245 C)
 * License : MIT
 */

import express from 'express';

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = Number(process.env.PORT || 3000);
const HIVE_BASE = (process.env.HIVE_BASE || 'https://hive-gamification.onrender.com').replace(/\/$/, '');
const HIVE_TIMEOUT_MS = Number(process.env.HIVE_TIMEOUT_MS || 15000);

// ─── Layer 1 — InMemoryBudgetHook (4 levels) ─────────────────────────────────
//
// This is the same hierarchy spec exposed by @hivemorph/qvac-client v0.2's
// BudgetHook interface. Caps are configured via env (NAMESPACE_CAP, etc.) or
// per-key via the budget_set_cap tool. Spend/reservations are in-memory and
// reset on process restart — appropriate for a reference integration; swap
// for Redis or a remote service in production.

const LEVELS = ['namespace', 'user', 'agent', 'task'];

const defaultCaps = {
  namespace: Number(process.env.NAMESPACE_CAP || 50),  // 50 USDC/USDT total
  user:      Number(process.env.USER_CAP      || 10),
  agent:     Number(process.env.AGENT_CAP     || 2),
  task:      Number(process.env.TASK_CAP      || 0.50),
};

const budget = {
  caps: {                                  // level → { key → cap }
    namespace: {}, user: {}, agent: {}, task: {},
  },
  spent: new Map(),                        // `${level}:${key}` → number
  reserved: new Map(),
  reservations: new Map(),                 // resId → { scope, amount, asset, settled }
  seq: 0,
};

function bk(level, key) { return `${level}:${key}`; }
function capFor(level, key) {
  const m = budget.caps[level];
  if (m && key in m) return m[key];
  return defaultCaps[level] ?? Number.POSITIVE_INFINITY;
}
function headroom(level, key) {
  const cap = capFor(level, key);
  if (!Number.isFinite(cap)) return Number.POSITIVE_INFINITY;
  const k = bk(level, key);
  return cap - (budget.spent.get(k) || 0) - (budget.reserved.get(k) || 0);
}
function bucketsFor(scope) {
  const out = [];
  for (const lvl of LEVELS) if (scope[lvl]) out.push([lvl, scope[lvl]]);
  return out;
}
function atomicReserve({ scope, amount, asset, memo }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0) {
    return { ok: false, reason: 'invalid amount' };
  }
  const buckets = bucketsFor(scope);
  if (buckets.length === 0) {
    return { ok: false, reason: 'scope must include at least one level' };
  }
  let binding, bindingHead = Number.POSITIVE_INFINITY;
  for (const [lvl, key] of buckets) {
    const h = headroom(lvl, key);
    if (h < amt) return { ok: false, reason: `${lvl}:${key} headroom=${h}` };
    if (h < bindingHead) { bindingHead = h; binding = lvl; }
  }
  for (const [lvl, key] of buckets) {
    const k = bk(lvl, key);
    budget.reserved.set(k, (budget.reserved.get(k) || 0) + amt);
  }
  const id = `res_${++budget.seq}_${Date.now()}`;
  budget.reservations.set(id, { scope, amount: amt, asset, memo, settled: false });
  return { ok: true, reservationId: id, bindingLevel: binding };
}
function settle(reservationId, actualAmount) {
  const r = budget.reservations.get(reservationId);
  if (!r || r.settled) return false;
  const actual = actualAmount === undefined ? r.amount : Number(actualAmount);
  const finalSpend = Math.max(0, Math.min(actual, r.amount));
  for (const [lvl, key] of bucketsFor(r.scope)) {
    const k = bk(lvl, key);
    budget.reserved.set(k, (budget.reserved.get(k) || 0) - r.amount);
    budget.spent.set(k, (budget.spent.get(k) || 0) + finalSpend);
  }
  r.settled = true;
  return true;
}
function release(reservationId) {
  const r = budget.reservations.get(reservationId);
  if (!r || r.settled) return false;
  for (const [lvl, key] of bucketsFor(r.scope)) {
    const k = bk(lvl, key);
    budget.reserved.set(k, (budget.reserved.get(k) || 0) - r.amount);
  }
  r.settled = true;
  return true;
}

// ─── Hive Gamification HTTP helpers ──────────────────────────────────────────

async function hiveGet(path, params = {}) {
  const url = new URL(`${HIVE_BASE}${path.startsWith('/') ? path : '/' + path}`);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(HIVE_TIMEOUT_MS) });
  let data; try { data = await res.json(); } catch { data = { raw: await res.text() }; }
  return { status: res.status, data };
}

async function hivePost(path, body) {
  const res = await fetch(`${HIVE_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(HIVE_TIMEOUT_MS),
  });
  let data; try { data = await res.json(); } catch { data = { raw: await res.text() }; }
  return { status: res.status, data };
}

// ─── Door registry ───────────────────────────────────────────────────────────
//
// Each door knows its primary action endpoint, the price it charges, and the
// settlement asset. Prices are enforced at Layer 1 BEFORE the upstream POST.

const DOORS = {
  'computational-debt':       { post: '/v1/debt/subscribe',           price: 0.50, asset: 'USDC', term: '30d' },
  'protocol-consensus-tax':   { post: '/v1/pct/subscribe',            price: 0.25, asset: 'USDC', term: '1 read' },
  'pheromone-priority':       { post: '/v1/pheromone/subscribe',      price: 5.00, asset: 'USDC', term: '30d' },
  'zk-compliance-shield':     { post: '/v1/compliance/subscribe',     price: 1.00, asset: 'USDC', term: '30d' },
  'capability-leasing':       { post: '/v1/lease/start',              price: 0.15, asset: 'USDC', term: '1h' },
  'guild-synergy':            { post: '/v1/guild_synergy/subscribe',  price: 10.00, asset: 'USDC', term: '30d' },
  'audit-trail-premium':      { post: '/v1/audit_premium/subscribe',  price: 3.00, asset: 'USDC', term: '30d' },
  'bounty-routing':           { post: '/v1/bounty_routing/route',     price: 0.50, asset: 'USDC', term: '1 routing' },
};

function doorInfo(id) {
  const d = DOORS[id];
  if (!d) throw new Error(`Unknown door: ${id}`);
  return d;
}

/**
 * Each door's upstream POST expects a slightly different body shape. Map
 * our canonical (did, agent_id) onto the right field names so callers do
 * not have to know the upstream schemas.
 */
function buildUpstreamBody(door_id, did, agent_id, extra) {
  const a = agent_id || did;
  const e = extra || {};
  switch (door_id) {
    case 'computational-debt':            // SubscribeRequest: caller_did
      return { caller_did: did, ...e };
    case 'protocol-consensus-tax':        // SubscribeRequest: reader_did
      return { reader_did: did, ...e };
    case 'pheromone-priority':            // SubscribeRequest: did, tier?
      return { did, ...e };
    case 'zk-compliance-shield':          // SubscribeRequest: did
      return { did, ...e };
    case 'capability-leasing':            // /lease/start — see catalog
      return { lessee_did: did, agent_id: a, ...e };
    case 'guild-synergy':                 // SubscribeRequest: guild_id, paid_by_did
      return { guild_id: e.guild_id || a, paid_by_did: did, ...e };
    case 'audit-trail-premium':           // SubscribeRequest: did
      return { did, ...e };
    case 'bounty-routing':                // RouteRequest: submitter_did, bounty_id, base_fee_usdc, routing_tier
      return { submitter_did: did, ...e };
    default:
      return { did, agent_id: a, ...e };
  }
}

// ─── Tool execution ──────────────────────────────────────────────────────────

async function executeTool(name, args = {}) {
  switch (name) {

    // ── Budget surface ────────────────────────────────────────────────────
    case 'budget_status': {
      const out = {
        defaults: defaultCaps,
        levels: {},
        active_reservations: [...budget.reservations.values()].filter(r => !r.settled).length,
      };
      for (const lvl of LEVELS) {
        out.levels[lvl] = {};
        const keys = new Set([
          ...Object.keys(budget.caps[lvl]),
          ...[...budget.spent.keys(), ...budget.reserved.keys()]
            .filter(k => k.startsWith(`${lvl}:`))
            .map(k => k.slice(lvl.length + 1)),
        ]);
        for (const k of keys) {
          out.levels[lvl][k] = {
            cap: capFor(lvl, k),
            spent: budget.spent.get(bk(lvl, k)) || 0,
            reserved: budget.reserved.get(bk(lvl, k)) || 0,
            headroom: headroom(lvl, k),
          };
        }
      }
      return { type: 'text', text: JSON.stringify(out, null, 2) };
    }

    case 'budget_set_cap': {
      const { level, key, cap } = args;
      if (!LEVELS.includes(level)) throw new Error(`level must be one of ${LEVELS.join(', ')}`);
      if (!key || typeof key !== 'string') throw new Error('key required');
      if (typeof cap !== 'number' || cap < 0) throw new Error('cap must be a non-negative number');
      budget.caps[level][key] = cap;
      return { type: 'text', text: JSON.stringify({ ok: true, level, key, cap }, null, 2) };
    }

    case 'budget_check': {
      const { scope, amount, asset = 'USDC' } = args;
      if (!scope || typeof scope !== 'object') throw new Error('scope object required');
      if (typeof amount !== 'string' && typeof amount !== 'number') throw new Error('amount required');
      const buckets = bucketsFor(scope);
      const checks = buckets.map(([lvl, key]) => ({
        level: lvl, key,
        cap: capFor(lvl, key),
        headroom: headroom(lvl, key),
        sufficient: headroom(lvl, key) >= Number(amount),
      }));
      return {
        type: 'text',
        text: JSON.stringify({
          ok: checks.every(c => c.sufficient),
          asset, amount: String(amount), scope, checks,
        }, null, 2),
      };
    }

    // ── Door discovery ────────────────────────────────────────────────────
    case 'doors_list': {
      const list = Object.entries(DOORS).map(([id, d]) => ({
        id, endpoint: d.post, price: d.price, asset: d.asset, term: d.term,
      }));
      return { type: 'text', text: JSON.stringify({ doors: list, count: list.length }, null, 2) };
    }

    case 'door_economics': {
      const { door_id } = args;
      const d = doorInfo(door_id);
      const economicsPath = d.post.replace(/\/(subscribe|start|route)$/, '/economics');
      const r = await hiveGet(economicsPath);
      return { type: 'text', text: JSON.stringify({ door_id, ...d, upstream: r }, null, 2) };
    }

    case 'bogo_claim': {
      const { door_id, did, agent_id } = args;
      if (!door_id) throw new Error('door_id required');
      if (!did) throw new Error('did required');
      doorInfo(door_id);
      const r = await hivePost('/v1/bogo/claim', {
        mechanic_id: door_id,
        did,
        agent_id: agent_id || did,
      });
      return { type: 'text', text: JSON.stringify({ door_id, ...r }, null, 2) };
    }

    // ── Door actions (gated by Layer 1 budget) ────────────────────────────
    case 'door_subscribe': {
      const {
        door_id, did, agent_id, scope, body,
      } = args;
      if (!door_id) throw new Error('door_id required');
      if (!did) throw new Error('did required');
      if (!scope) throw new Error('scope required (Namespace/User/Agent/Task hierarchy)');

      const d = doorInfo(door_id);
      const reserveRes = atomicReserve({
        scope,
        amount: String(d.price),
        asset: d.asset,
        memo: `door:${door_id} did:${did}`,
      });
      if (!reserveRes.ok) {
        return {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            door_id,
            blocked_by: 'layer1_budget',
            reason: reserveRes.reason,
          }, null, 2),
        };
      }

      // Map our canonical `did` arg onto each door's expected upstream
      // body shape. The Hive Gamification routes use `caller_did` for
      // most subscribe-style endpoints, with a few exceptions (lease,
      // bounty_routing, pheromone). The user-supplied `body` overrides
      // any of these defaults.
      const upstreamBody = buildUpstreamBody(door_id, did, agent_id, body);

      let upstream;
      try {
        upstream = await hivePost(d.post, upstreamBody);
      } catch (err) {
        release(reserveRes.reservationId);
        throw err;
      }

      const ok2xx = upstream.status >= 200 && upstream.status < 300;
      if (ok2xx) {
        settle(reserveRes.reservationId);
      } else {
        release(reserveRes.reservationId);
      }
      return {
        type: 'text',
        text: JSON.stringify({
          ok: ok2xx,
          door_id,
          price: d.price,
          asset: d.asset,
          reservationId: reserveRes.reservationId,
          binding_level: reserveRes.bindingLevel,
          upstream,
        }, null, 2),
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Tool definitions (advertised via tools/list) ────────────────────────────

const TOOLS = [
  {
    name: 'budget_status',
    description: 'Inspect Layer 1 (internal hierarchical) budget — caps, spend, reservations, and remaining headroom across Namespace, User, Agent, Task levels. Free read.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'budget_set_cap',
    description: 'Set or override a per-key cap at one of the four budget levels (namespace, user, agent, task). Caps are inclusive ceilings on cumulative spend at that level.',
    inputSchema: {
      type: 'object',
      required: ['level', 'key', 'cap'],
      properties: {
        level: { type: 'string', enum: ['namespace', 'user', 'agent', 'task'] },
        key: { type: 'string', description: 'The identifier at this level (namespace name, DID, agent id, task id)' },
        cap: { type: 'number', description: 'Inclusive cap in USDC equivalent' },
      },
    },
  },
  {
    name: 'budget_check',
    description: 'Pre-flight: would a given amount fit under all configured caps for this scope? Read-only, no reservation taken.',
    inputSchema: {
      type: 'object',
      required: ['scope', 'amount'],
      properties: {
        scope: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            user: { type: 'string' },
            agent: { type: 'string' },
            task: { type: 'string' },
          },
        },
        amount: { type: ['string', 'number'] },
        asset: { type: 'string', enum: ['USDC', 'USDT'], default: 'USDC' },
      },
    },
  },
  {
    name: 'doors_list',
    description: 'List all 8 Hive BOGO doors with endpoint, price, asset, and term. No auth required.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'door_economics',
    description: 'Fetch the live /economics surface for one door (full pricing schedule, settlement currency, recipient).',
    inputSchema: {
      type: 'object',
      required: ['door_id'],
      properties: {
        door_id: {
          type: 'string',
          enum: Object.keys(DOORS),
          description: 'Door identifier — see doors_list.',
        },
      },
    },
  },
  {
    name: 'bogo_claim',
    description: 'Claim the first-use-free entitlement for a given door + DID via /v1/bogo/claim. Does not bypass the Layer 1 budget for subsequent paid actions.',
    inputSchema: {
      type: 'object',
      required: ['door_id', 'did'],
      properties: {
        door_id: { type: 'string', enum: Object.keys(DOORS) },
        did: { type: 'string', description: 'DID claiming the BOGO' },
        agent_id: { type: 'string', description: 'Agent id (defaults to did)' },
      },
    },
  },
  {
    name: 'door_subscribe',
    description: 'Atomic reserve → upstream POST → settle. Reserves the door price under all four levels in scope; only proceeds if every level has headroom. On 2xx the reservation settles; on any failure it is released. This is the canonical path through the bridge.',
    inputSchema: {
      type: 'object',
      required: ['door_id', 'did', 'scope'],
      properties: {
        door_id: { type: 'string', enum: Object.keys(DOORS) },
        did: { type: 'string' },
        agent_id: { type: 'string' },
        scope: {
          type: 'object',
          description: 'Hierarchy path. Any prefix is valid; the most-restrictive level governs.',
          properties: {
            namespace: { type: 'string' },
            user: { type: 'string' },
            agent: { type: 'string' },
            task: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          description: 'Optional extra fields forwarded to the upstream subscribe/start/route endpoint.',
        },
      },
    },
  },
];

// ─── MCP JSON-RPC handler ────────────────────────────────────────────────────

app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC' } });
  }
  try {
    switch (method) {
      case 'initialize':
        return res.json({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: 'hive-mcp-openclaw-bridge',
              version: '1.0.0',
              description: 'Reference integration with @kinthaiofficial OpenClaw 3-layer payment governance — wraps Hive Gamification 8 BOGO doors behind a 4-level Layer 1 hierarchical budget.',
            },
          },
        });
      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const out = await executeTool(name, args || {});
        return res.json({ jsonrpc: '2.0', id, result: { content: [out] } });
      }
      case 'ping':
        return res.json({ jsonrpc: '2.0', id, result: {} });
      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
  }
});

// ─── Discovery + health ──────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({
  status: 'ok',
  service: 'hive-mcp-openclaw-bridge',
  version: '1.0.0',
  backend: HIVE_BASE,
  doors: Object.keys(DOORS).length,
  budget_levels: LEVELS,
}));

app.get('/.well-known/mcp.json', (_req, res) => res.json({
  name: 'hive-mcp-openclaw-bridge',
  endpoint: '/mcp',
  transport: 'streamable-http',
  protocol: '2024-11-05',
  tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
}));

// Internal export for unit tests (when imported as a module).
export const _internal = {
  app,
  budget,
  defaultCaps,
  DOORS,
  atomicReserve,
  settle,
  release,
  headroom,
  capFor,
  executeTool,
  TOOLS,
};

// Only listen when run directly (not when imported by the test runner).
const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  app.listen(PORT, () => {
    console.log(`hive-mcp-openclaw-bridge running on :${PORT}`);
    console.log(`  Backend : ${HIVE_BASE}`);
    console.log(`  Doors   : ${Object.keys(DOORS).length}`);
    console.log(`  Tools   : ${TOOLS.length}`);
    console.log(`  Caps    : ns=${defaultCaps.namespace} user=${defaultCaps.user} agent=${defaultCaps.agent} task=${defaultCaps.task}`);
  });
}
