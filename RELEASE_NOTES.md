# v1.0.0 — hive-mcp-openclaw-bridge

Reference integration with [@kinthaiofficial](https://blog.kinthai.ai)'s **OpenClaw** 3-layer payment governance framework.

## What ships

- **MCP server** (Streamable-HTTP, JSON-RPC 2.0, MCP 2024-11-05) wrapping Hive Gamification's 8 BOGO doors
- **4-level Layer-1 budget hierarchy** — Namespace → User → Agent → Task
- **Atomic reserve / settle / release** lifecycle around every external x402 settlement
- **7 tools**: `budget_status`, `budget_set_cap`, `budget_check`, `doors_list`, `door_economics`, `bogo_claim`, `door_subscribe`

## Doors covered

`computational-debt`, `protocol-consensus-tax`, `pheromone-priority`, `zk-compliance-shield`, `capability-leasing`, `guild-synergy`, `audit-trail-premium`, `bounty-routing`.

Backend: `https://hive-gamification.onrender.com`. Real rails. No mock settlement.

## Companion package

The `BudgetHook` interface this server implements is also exposed by [@hivemorph/qvac-client v0.2.0](https://www.npmjs.com/package/@hivemorph/qvac-client) — drop in your own implementation to wire the same 4-level hierarchy into any x402-enabled endpoint.

## Reading

- [Agent wallet economic models for autonomous agents](https://blog.kinthai.ai/agent-wallet-economic-models-autonomous-agents)
- [221 agents: multi-agent coordination lessons](https://blog.kinthai.ai/221-agents-multi-agent-coordination-lessons)
- [agents.kinthai.ai](https://agents.kinthai.ai)

## Council provenance

Ad-hoc reference integration. Not gated by R3/R4/R5/R6.

Brand: Hive Civilization gold `#C08D23` (Pantone 1245 C).
License: MIT.
