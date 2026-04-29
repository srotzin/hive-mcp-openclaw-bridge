# hive-mcp-openclaw-bridge

> Reference integration with [@kinthaiofficial](https://blog.kinthai.ai)'s **OpenClaw** 3-layer payment governance framework.
> MCP server that wraps Hive Gamification's 8 BOGO doors behind a 4-level hierarchical budget — atomic reserve, upstream POST, settle/release.
> Real rails. No mock settlement.

Brand: Hive Civilization gold `#C08D23` (Pantone 1245 C).
License: MIT.

---

## Why this exists

OpenClaw's three-layer model splits payment governance into three concerns:

| Layer | Concern | Where it lives |
|---|---|---|
| **Layer 1** | Internal hierarchical budget — atomic reserve / settle | this server |
| **Layer 2** | Inter-agent millicent ledger settled at epoch boundaries | OpenClaw |
| **Layer 3** | External x402 settlement on real rails | Hive Gamification |

This bridge demonstrates the Layer 1 ↔ Layer 3 seam. Every paid call to a Hive door (computational-debt, protocol-consensus-tax, pheromone-priority, zk-compliance-shield, capability-leasing, guild-synergy, audit-trail-premium, bounty-routing) is gated by an **atomic reservation** against every level in the caller's scope path:

```
Namespace → User → Agent → Task
```

The most-restrictive level governs. If any level is short of headroom, the upstream HTTP request is never made and no x402 settlement is signed.

The same `BudgetHook` interface is exposed from [@hivemorph/qvac-client v0.2](https://www.npmjs.com/package/@hivemorph/qvac-client) — drop your own implementation in to wire this hierarchy into a different runtime.

## Background reading

- [Agent wallet economic models for autonomous agents](https://blog.kinthai.ai/agent-wallet-economic-models-autonomous-agents) — kinthai
- [221 agents: multi-agent coordination lessons](https://blog.kinthai.ai/221-agents-multi-agent-coordination-lessons) — kinthai
- [agents.kinthai.ai](https://agents.kinthai.ai) — running on OpenClaw

## Tools

| Tool | What it does |
|---|---|
| `budget_status` | Inspect caps, spend, reservations, headroom across all 4 levels |
| `budget_set_cap` | Override a per-key cap at one level |
| `budget_check` | Read-only pre-flight against a proposed amount + scope |
| `doors_list` | List all 8 BOGO doors with endpoint, price, asset, term |
| `door_economics` | Fetch live `/economics` for one door |
| `bogo_claim` | Claim first-use-free via `/v1/bogo/claim` |
| `door_subscribe` | **Canonical gated path** — atomic reserve → upstream POST → settle/release |

## Doors

| Door | Endpoint | Price | Term |
|---|---|---|---|
| computational-debt | `/v1/debt/subscribe` | 0.50 USDC | 30d |
| protocol-consensus-tax | `/v1/pct/subscribe` | 0.25 USDC | 1 read |
| pheromone-priority | `/v1/pheromone/subscribe` | 5.00 USDC | 30d |
| zk-compliance-shield | `/v1/compliance/subscribe` | 1.00 USDC | 30d |
| capability-leasing | `/v1/lease/start` | 0.15 USDC | 1h |
| guild-synergy | `/v1/guild_synergy/subscribe` | 10.00 USDC | 30d |
| audit-trail-premium | `/v1/audit_premium/subscribe` | 3.00 USDC | 30d |
| bounty-routing | `/v1/bounty_routing/route` | 0.50 USDC | 1 routing |

Backend: `https://hive-gamification.onrender.com`. All endpoints are live and verified.

## Lifecycle of a paid call

```
client → tools/call door_subscribe { door_id, did, scope }
       → atomicReserve(scope, price, asset)
           ├─ each level checked: namespace, user, agent, task
           ├─ headroom = cap − spent − reserved
           └─ short on any level? reject before signing
       → POST hive-gamification.onrender.com<endpoint>
       → 2xx? settle(reservationId)
         non-2xx or throw? release(reservationId)
       → return { ok, reservationId, binding_level, upstream }
```

## Quickstart

```bash
git clone https://github.com/srotzin/hive-mcp-openclaw-bridge
cd hive-mcp-openclaw-bridge
npm install
npm start
```

Then from any MCP client:

```json
POST http://localhost:3000/mcp
{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
```

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `HIVE_BASE` | `https://hive-gamification.onrender.com` | upstream base URL |
| `HIVE_TIMEOUT_MS` | `15000` | upstream fetch timeout |
| `NAMESPACE_CAP` | `50` | default namespace-level cap (USDC) |
| `USER_CAP` | `10` | default user-level cap |
| `AGENT_CAP` | `2` | default agent-level cap |
| `TASK_CAP` | `0.50` | default task-level cap |

Per-key caps override defaults via `budget_set_cap`.

## Related

- [@hivemorph/qvac-client v0.2](https://www.npmjs.com/package/@hivemorph/qvac-client) — TypeScript SDK exposing the same `BudgetHook` interface against any x402-enabled endpoint.
- [Hive Gamification agent card](https://hive-gamification.onrender.com/.well-known/agent-card.json) — A2A 0.1 advertisement of the 8 doors.

## License

MIT — see `LICENSE`.

## Hive Civilization Directory

Part of the Hive Civilization — agent-native financial infrastructure.

- Endpoint Directory: https://thehiveryiq.com
- Live Leaderboard: https://hive-a2amev.onrender.com/leaderboard
- Revenue Dashboard: https://hivemine-dashboard.onrender.com
- Other MCP Servers: https://github.com/srotzin?tab=repositories&q=hive-mcp

Brand: #C08D23
<!-- /hive-footer -->
