# ghl-agency-ops-mcp

> The only GoHighLevel MCP built for agencies managing multiple client sub-accounts — with dry-run writes, multi-location switching, snapshot deployment, cross-location reporting, and a lean 12-tool footprint safe enough for production.

[![MCPize](https://img.shields.io/badge/MCPize-Listed-blue)](https://mcpize.com/mcp/ghl-agency-ops-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## Why this exists

Every other GHL MCP either:
- Ships 500+ tools that consume 350,000 tokens and have no write safety, or
- Is the official GHL MCP which is a raw HTTP bridge with no dry-run layer

Neither is safe for an agency managing 10–50 client sub-accounts. One AI write to the wrong location corrupts a client's CRM. This server solves that.

**The core safety model:**
1. You explicitly `switch_location` before any write — scoped token, isolated client
2. All writes show a dry-run diff first
3. Execution requires `confirm: true`
4. Every write logs an audit timestamp

---

## Tools (12 total — lean by design)

| # | Tool | Type | Description |
|---|------|------|-------------|
| 1 | `ghl_whoami` | Read | Agency auth probe + full sub-account roster |
| 2 | `list_locations` | Read | Paginated sub-account list with health signals |
| 3 | `switch_location` | Session | Set active client — scoped token, isolated write target |
| 4 | `get_location_summary` | Read | Full snapshot of one client: pipelines, contacts, details |
| 5 | `preview_contact_write` | Dry-run | Diff contact create/update — nothing applied |
| 6 | `execute_contact_write` | Write | Confirmed contact create/update + audit note |
| 7 | `preview_opportunity_update` | Dry-run | Diff pipeline stage, value, status change |
| 8 | `execute_opportunity_update` | Write | Confirmed opportunity update + audit note |
| 9 | `list_snapshots` | Read | Agency snapshot library (own / imported / vertical) |
| 10 | `deploy_snapshot` | Write | Dry-run or confirmed snapshot → sub-account |
| 11 | `provision_subaccount` | Write | Dry-run or confirmed new sub-account creation + snapshot |
| 12 | `cross_location_report` | Read | Weekly digest: contacts, open opps, pipeline value across all clients |

---

## Why 12 tools and not 500

The 500-tool servers use **350,000+ tokens per session** — more than most LLM context windows. This server uses ~12,000 tokens. That means:
- Claude can hold the full tool list in context
- Responses are faster
- Cost per session is a fraction
- The tools are focused on what agencies actually need daily

---

## Quickstart

### 1. Clone & install

```bash
git clone https://github.com/YOUR_USERNAME/ghl-agency-ops-mcp.git
cd ghl-agency-ops-mcp
npm install
```

### 2. Configure credentials

```bash
cp .env.example .env
```

**Getting your Agency credentials:**

1. Log into GHL as Agency Admin
2. Go to **Settings → Private Integrations → Create Integration**
3. Select **Agency-level** scopes:
   - `locations.readonly` + `locations.write`
   - `contacts.readonly` + `contacts.write`
   - `opportunities.readonly` + `opportunities.write`
   - `snapshots.readonly`
4. Copy the token → `GHL_AGENCY_TOKEN`
5. Go to **Settings → Company** → copy the Company/Agency ID → `GHL_COMPANY_ID`

> ⚠️ Use a **Private Integration Token**, not a regular API key. GHL deprecated regular API keys as of Dec 2025.

### 3. Build

```bash
npm run build
```

### 4. Connect to Claude Desktop

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ghl-agency-ops": {
      "command": "node",
      "args": ["/absolute/path/to/ghl-agency-ops-mcp/dist/index.js"],
      "env": {
        "GHL_AGENCY_TOKEN": "pit-xxxxxxxxxxxxxxxxxxxx",
        "GHL_COMPANY_ID":   "5DP4iH6HLkQsiKESj6rh"
      }
    }
  }
}
```

Restart Claude Desktop. Type `ghl_whoami` to confirm connection.

### 5. Test locally with MCP Inspector

```bash
npm run inspect
```

---

## Safety model — step by step

Every session follows this pattern:

```
1. ghl_whoami            → confirm connected, see all sub-accounts
2. list_locations         → find the client you need
3. switch_location        → lock in that client (scoped token)
4. get_location_summary   → review their current state
5. preview_*              → see exactly what will change
6. execute_* confirm:true → apply with audit trail
```

Skipping `switch_location` before a write will return a clear error — not a silent write to the wrong account.

---

## Example prompts

```
Show me all my agency sub-accounts
```
```
Switch to Acme Dental and show me their pipeline summary
```
```
Preview adding a contact named John Smith (john@acme.com) to the active location
```
```
Show me all my agency snapshots
```
```
Preview deploying the Dental Niche snapshot to the new Acme Dental sub-account
```
```
Provision a new sub-account for "Riverside Auto" with email ops@riverside.com,
apply the Auto Dealer snapshot — show me the dry-run first
```
```
Give me a cross-location report across all my clients
```
```
Preview moving opportunity ABC123 to the Closed Won stage and marking value as $4500
```

---

## Credentials & API reference

| Env var | Required | Where to find |
|---------|----------|---------------|
| `GHL_AGENCY_TOKEN` | ✅ | GHL → Settings → Private Integrations → Agency-level token |
| `GHL_COMPANY_ID` | ✅ | GHL → Settings → Company → Company ID (in URL or page) |

**API version:** `2021-07-28` (GHL V2 — V1 deprecated Dec 2025)
**Base URL:** `https://services.leadconnectorhq.com`
**Rate limits:** 100 req/10s burst, 200k/day per app per location

---

## Architecture decisions

**Why location token exchange?** GHL's V2 API separates agency-level and sub-account-level tokens. The server calls `POST /oauth/locationToken` on `switch_location` to get a properly scoped token — this is what enforces client data isolation. Writing with an agency token to a sub-account endpoint is the pattern that causes cross-client data leaks in naive implementations.

**Why session state?** The active location + token is held in memory for the session. This means one `switch_location` call covers all subsequent operations without requiring a locationId on every tool call. Intentional trade-off: stateful but simple.

**Why not workflows/social/blog tools?** Those are high-blast-radius operations. This MVP focuses on the daily agency ops loop: contacts, opportunities, snapshots, provisioning, reporting. The 500-tool servers cover the rest for power users who accept the risk.

---

## Development

```bash
npm run dev       # tsx watch — live reload
npm run build     # compile to dist/
npm run inspect   # MCP Inspector UI at localhost
```

---

## Roadmap

- [ ] `list_pipelines` — per-location pipeline + stage detail
- [ ] `search_contacts` — cross-location contact search
- [ ] `workflow_trigger` — trigger a workflow for a contact (dry-run default)
- [ ] `agency_revenue_report` — MRR / subscription rollup across SaaS Mode locations
- [ ] OAuth multi-tenant flow for resellers
- [ ] `bulk_tag_contacts` — dry-run batch tagging with blast-radius cap

---

## Competitive position

| Feature | ghl-agency-ops-mcp | BusyBee 520-tool | Official GHL MCP |
|---------|-------------------|-----------------|-----------------|
| Dry-run first writes | ✅ | ❌ | ❌ |
| Multi-location switching | ✅ | ❌ (manual header) | ❌ |
| Location-scoped token isolation | ✅ | ❌ | ❌ |
| Snapshot deploy (dry-run) | ✅ | ❌ | ❌ |
| Sub-account provisioning | ✅ | ❌ | ❌ |
| Cross-location report | ✅ | ❌ | ❌ |
| Token footprint | ~12k tokens | ~350k tokens | varies |
| MCPize hosted + BYOK | ✅ | ❌ | ❌ |

---

## License

MIT — see [LICENSE](LICENSE)

---

## MCPize

Available on [MCPize marketplace](https://mcpize.com/mcp/ghl-agency-ops-mcp) with hosted deployment, BYOK setup, and tiered pricing. Agencies on the $297–$497/mo GHL plan are the primary buyer.
