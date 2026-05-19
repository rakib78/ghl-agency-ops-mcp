/**
 * ghl-agency-ops-mcp
 * The only GoHighLevel MCP built for agencies managing multiple client
 * sub-accounts — with dry-run writes, multi-location switching, snapshot
 * deployment, cross-location reporting, and a lean 12-tool footprint.
 *
 * MVP v1.0 | TypeScript | MCP SDK | MCPize-ready
 *
 * Tools:
 *   ghl_whoami                  — agency auth probe + sub-account roster
 *   list_locations              — paginated sub-account list with health signals
 *   switch_location             — set active location for session
 *   get_location_summary        — full snapshot of one client sub-account
 *   preview_contact_write       — dry-run contact create/update diff
 *   execute_contact_write       — confirmed contact create/update
 *   preview_opportunity_update  — dry-run pipeline stage / value change
 *   execute_opportunity_update  — confirmed opportunity update
 *   list_snapshots              — agency snapshot library
 *   deploy_snapshot             — dry-run or confirmed snapshot → sub-account
 *   provision_subaccount        — dry-run or confirmed new sub-account creation
 *   cross_location_report       — weekly digest across all (or selected) locations
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── Config ──────────────────────────────────────────────────────────────────

const AGENCY_TOKEN  = process.env.GHL_AGENCY_TOKEN  ?? "";  // Agency-level Private Integration Token
const COMPANY_ID    = process.env.GHL_COMPANY_ID    ?? "";  // Agency/Company ID
const BASE          = "https://services.leadconnectorhq.com";
const API_VERSION   = "2021-07-28";

if (!AGENCY_TOKEN || !COMPANY_ID) {
  console.error(
    "Missing env vars: GHL_AGENCY_TOKEN, GHL_COMPANY_ID\n" +
    "Get these from: GHL Agency View → Settings → Private Integrations"
  );
  process.exit(1);
}

// ─── Active location state (session-scoped) ───────────────────────────────────

let activeLocationId: string | null = null;
let activeLocationToken: string | null = null;
let activeLocationName: string | null = null;

// ─── HTTP Client ──────────────────────────────────────────────────────────────

async function ghl<T>(
  path: string,
  opts: RequestInit = {},
  token?: string,
  retries = 3
): Promise<T> {
  const url = `${BASE}${path}`;
  const tok = token ?? AGENCY_TOKEN;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tok}`,
    Version: API_VERSION,
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string> ?? {}),
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, { ...opts, headers });

    if (res.status === 429) {
      const wait = parseInt(res.headers.get("Retry-After") ?? "10", 10);
      await sleep((wait + attempt * 3) * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new GHLError(res.status, body);
    }
    return res.json() as Promise<T>;
  }
  throw new GHLError(429, "Rate limit exceeded after retries");
}

// Exchange agency token for a location-scoped token
async function getLocationToken(locationId: string): Promise<string> {
  const data = await ghl<{ access_token: string }>("/oauth/locationToken", {
    method: "POST",
    body: JSON.stringify({ companyId: COMPANY_ID, locationId }),
  });
  return data.access_token;
}

class GHLError extends Error {
  constructor(public status: number, message: string) {
    super(`GHL ${status}: ${message}`);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Guardrail helpers ────────────────────────────────────────────────────────

function dryRun(preview: unknown) {
  return {
    dry_run: true,
    message: "⚠️ DRY RUN — no changes applied. Re-run with dry_run: false to execute.",
    preview,
  };
}

function requireLocation(): string {
  if (!activeLocationId) {
    throw new Error(
      "No active location set. Run switch_location first with the target locationId."
    );
  }
  return activeLocationId;
}

function requireLocationToken(): string {
  if (!activeLocationToken) {
    throw new Error(
      "No location token available. Run switch_location first."
    );
  }
  return activeLocationToken;
}

// ─── GHL types (minimal) ─────────────────────────────────────────────────────

interface GHLLocation {
  id: string; name: string; email?: string; phone?: string;
  address?: string; city?: string; state?: string; country?: string;
  website?: string; timezone?: string; companyId: string;
}

interface GHLContact {
  id?: string; firstName?: string; lastName?: string;
  email?: string; phone?: string; tags?: string[];
  assignedTo?: string; source?: string;
}

interface GHLOpportunity {
  id: string; name: string; status: string;
  monetaryValue?: number; pipelineId: string;
  pipelineStageId: string; assignedTo?: string;
  contactId: string;
}

interface GHLSnapshot {
  id: string; name: string; type: string;
  updatedAt?: string;
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "ghl-agency-ops-mcp",
  version: "1.0.0",
});

// ── 1. ghl_whoami ─────────────────────────────────────────────────────────────
server.tool(
  "ghl_whoami",
  "Verify agency auth, company ID, and list all sub-accounts in your agency.",
  {},
  async () => {
    try {
      const data = await ghl<{ locations: GHLLocation[] }>(
        `/locations/search?companyId=${COMPANY_ID}&limit=20`
      );
      const locations = data.locations ?? [];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "connected",
            company_id: COMPANY_ID,
            auth_type: "Agency Private Integration Token",
            sub_account_count: locations.length,
            active_location: activeLocationId
              ? { id: activeLocationId, name: activeLocationName }
              : null,
            sub_accounts: locations.map(l => ({
              id: l.id, name: l.name, city: l.city,
              state: l.state, timezone: l.timezone,
            })),
            note: "Run switch_location with a locationId before executing any write operations.",
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Auth failed: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── 2. list_locations ─────────────────────────────────────────────────────────
server.tool(
  "list_locations",
  "List all client sub-accounts in your agency with health signals.",
  {
    limit:  z.number().int().min(1).max(100).optional().default(50),
    search: z.string().optional().describe("Filter by name or email"),
    skip:   z.number().int().optional().default(0),
  },
  async ({ limit, search, skip }) => {
    try {
      const params = new URLSearchParams({
        companyId: COMPANY_ID,
        limit: String(limit),
        skip: String(skip),
        ...(search ? { name: search } : {}),
      });
      const data = await ghl<{ locations: GHLLocation[]; count: number }>(
        `/locations/search?${params}`
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total: data.count,
            returned: data.locations.length,
            skip,
            locations: data.locations.map(l => ({
              id: l.id, name: l.name, email: l.email,
              phone: l.phone, city: l.city, state: l.state,
              country: l.country, timezone: l.timezone,
            })),
            tip: "Use switch_location with any id above before writing to that sub-account.",
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }
);

// ── 3. switch_location ────────────────────────────────────────────────────────
server.tool(
  "switch_location",
  "Set the active client sub-account for this session. All subsequent writes target this location.",
  {
    location_id: z.string().describe("Sub-account / location ID to activate"),
  },
  async ({ location_id }) => {
    try {
      // Fetch location details
      const locData = await ghl<{ location: GHLLocation }>(
        `/locations/${location_id}`
      );
      // Exchange for location-scoped token
      const locToken = await getLocationToken(location_id);

      activeLocationId    = location_id;
      activeLocationToken = locToken;
      activeLocationName  = locData.location.name;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            switched: true,
            active_location: {
              id: activeLocationId,
              name: activeLocationName,
              city: locData.location.city,
              timezone: locData.location.timezone,
            },
            safety_note: "✅ Location token scoped to this sub-account only. Your other clients' data is isolated.",
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }
);

// ── 4. get_location_summary ───────────────────────────────────────────────────
server.tool(
  "get_location_summary",
  "Full snapshot of a client sub-account: details, pipeline count, contact count, recent activity.",
  {
    location_id: z.string().optional().describe("Location ID (defaults to active location)"),
  },
  async ({ location_id }) => {
    try {
      const locId = location_id ?? requireLocation();
      const locToken = location_id
        ? await getLocationToken(location_id)
        : requireLocationToken();

      const [locData, pipelines, contacts] = await Promise.all([
        ghl<{ location: GHLLocation }>(`/locations/${locId}`),
        ghl<{ pipelines: Array<{ id: string; name: string; stages: unknown[] }> }>(
          `/opportunities/pipelines?locationId=${locId}`, {}, locToken
        ).catch(() => ({ pipelines: [] })),
        ghl<{ meta: { total: number } }>(
          `/contacts/?locationId=${locId}&limit=1`, {}, locToken
        ).catch(() => ({ meta: { total: 0 } })),
      ]);

      const loc = locData.location;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            location: {
              id: loc.id, name: loc.name, email: loc.email,
              phone: loc.phone, address: loc.address,
              city: loc.city, state: loc.state, country: loc.country,
              timezone: loc.timezone, website: loc.website,
            },
            pipelines: pipelines.pipelines.map(p => ({
              id: p.id, name: p.name, stage_count: Array.isArray(p.stages) ? p.stages.length : 0,
            })),
            contact_count: contacts.meta?.total ?? "unavailable",
            tip: "Use switch_location to set this as the active sub-account before writing.",
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }
);

// ── 5. preview_contact_write ──────────────────────────────────────────────────
server.tool(
  "preview_contact_write",
  "DRY RUN — preview a contact create or update. No changes applied. Requires active location.",
  {
    mode: z.enum(["create", "update"]),
    contact_id: z.string().optional().describe("Required for update mode"),
    fields: z.object({
      firstName:  z.string().optional(),
      lastName:   z.string().optional(),
      email:      z.string().optional(),
      phone:      z.string().optional(),
      tags:       z.array(z.string()).optional(),
      source:     z.string().optional(),
      assignedTo: z.string().optional(),
    }),
  },
  async ({ mode, contact_id, fields }) => {
    try {
      const locId = requireLocation();

      if (mode === "update") {
        if (!contact_id) throw new Error("contact_id required for update mode");
        const existing = await ghl<{ contact: GHLContact }>(
          `/contacts/${contact_id}`, {}, requireLocationToken()
        );
        const c = existing.contact;
        const diff: Record<string, { before: unknown; after: unknown }> = {};

        if (fields.firstName && fields.firstName !== c.firstName)
          diff.firstName = { before: c.firstName, after: fields.firstName };
        if (fields.lastName && fields.lastName !== c.lastName)
          diff.lastName = { before: c.lastName, after: fields.lastName };
        if (fields.email && fields.email !== c.email)
          diff.email = { before: c.email, after: fields.email };
        if (fields.phone && fields.phone !== c.phone)
          diff.phone = { before: c.phone, after: fields.phone };
        if (fields.tags) diff.tags = { before: c.tags ?? [], after: fields.tags };
        if (fields.assignedTo && fields.assignedTo !== c.assignedTo)
          diff.assignedTo = { before: c.assignedTo, after: fields.assignedTo };

        return {
          content: [{
            type: "text",
            text: JSON.stringify(dryRun({
              mode, contact_id, location_id: locId,
              changes: diff,
              warning: Object.keys(diff).length === 0 ? "No changes detected." : null,
            }), null, 2),
          }],
        };
      }

      // Create mode
      return {
        content: [{
          type: "text",
          text: JSON.stringify(dryRun({
            mode, location_id: locId,
            will_create: { ...fields },
            note: "A new contact will be created with these fields.",
          }), null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }
);

// ── 6. execute_contact_write ──────────────────────────────────────────────────
server.tool(
  "execute_contact_write",
  "Create or update a contact. confirm must be true. Use preview_contact_write first.",
  {
    mode:       z.enum(["create", "update"]),
    contact_id: z.string().optional(),
    fields: z.object({
      firstName:  z.string().optional(),
      lastName:   z.string().optional(),
      email:      z.string().optional(),
      phone:      z.string().optional(),
      tags:       z.array(z.string()).optional(),
      source:     z.string().optional(),
      assignedTo: z.string().optional(),
    }),
    confirm: z.boolean().describe("Must be true to execute."),
  },
  async ({ mode, contact_id, fields, confirm }) => {
    const locId   = requireLocation();
    const locTok  = requireLocationToken();

    if (!confirm) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(dryRun({ mode, fields, reason: "confirm is false" }), null, 2),
        }],
      };
    }

    try {
      const body = { ...fields, locationId: locId };

      if (mode === "create") {
        const result = await ghl<{ contact: GHLContact }>("/contacts/", {
          method: "POST",
          body: JSON.stringify(body),
        }, locTok);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              executed: true, mode: "create",
              contact_id: result.contact.id,
              location_id: locId,
              audit: `Created at ${new Date().toISOString()} via ghl-agency-ops-mcp`,
            }, null, 2),
          }],
        };
      }

      if (!contact_id) throw new Error("contact_id required for update mode");
      const result = await ghl<{ contact: GHLContact }>(`/contacts/${contact_id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }, locTok);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            executed: true, mode: "update",
            contact_id: result.contact.id,
            location_id: locId,
            audit: `Updated at ${new Date().toISOString()} via ghl-agency-ops-mcp`,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }
);

// ── 7. preview_opportunity_update ─────────────────────────────────────────────
server.tool(
  "preview_opportunity_update",
  "DRY RUN — preview pipeline stage, value, or status change for an opportunity.",
  {
    opportunity_id: z.string(),
    changes: z.object({
      pipelineStageId: z.string().optional().describe("Move to this stage ID"),
      monetaryValue:   z.number().optional().describe("Update deal value"),
      status:          z.enum(["open", "won", "lost", "abandoned"]).optional(),
      assignedTo:      z.string().optional(),
    }),
  },
  async ({ opportunity_id, changes }) => {
    try {
      requireLocation();
      const locTok = requireLocationToken();
      const data = await ghl<{ opportunity: GHLOpportunity }>(
        `/opportunities/${opportunity_id}`, {}, locTok
      );
      const opp = data.opportunity;
      const diff: Record<string, { before: unknown; after: unknown }> = {};

      if (changes.pipelineStageId && changes.pipelineStageId !== opp.pipelineStageId)
        diff.pipelineStageId = { before: opp.pipelineStageId, after: changes.pipelineStageId };
      if (changes.monetaryValue !== undefined && changes.monetaryValue !== opp.monetaryValue)
        diff.monetaryValue = { before: opp.monetaryValue, after: changes.monetaryValue };
      if (changes.status && changes.status !== opp.status)
        diff.status = { before: opp.status, after: changes.status };
      if (changes.assignedTo && changes.assignedTo !== opp.assignedTo)
        diff.assignedTo = { before: opp.assignedTo, after: changes.assignedTo };

      const warnings: string[] = [];
      if (changes.status === "lost" || changes.status === "abandoned")
        warnings.push(`⚠️ Marking opportunity as "${changes.status}" — this may trigger automations.`);
      if (Object.keys(diff).length === 0)
        warnings.push("No changes detected.");

      return {
        content: [{
          type: "text",
          text: JSON.stringify(dryRun({
            opportunity_id,
            opportunity_name: opp.name,
            location_id: activeLocationId,
            diff, warnings,
          }), null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }
);

// ── 8. execute_opportunity_update ─────────────────────────────────────────────
server.tool(
  "execute_opportunity_update",
  "Apply opportunity changes. confirm must be true. Use preview_opportunity_update first.",
  {
    opportunity_id: z.string(),
    changes: z.object({
      pipelineStageId: z.string().optional(),
      monetaryValue:   z.number().optional(),
      status:          z.enum(["open", "won", "lost", "abandoned"]).optional(),
      assignedTo:      z.string().optional(),
    }),
    confirm: z.boolean(),
  },
  async ({ opportunity_id, changes, confirm }) => {
    requireLocation();
    const locTok = requireLocationToken();

    if (!confirm) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(dryRun({ opportunity_id, changes, reason: "confirm is false" }), null, 2),
        }],
      };
    }

    try {
      const result = await ghl<{ opportunity: GHLOpportunity }>(
        `/opportunities/${opportunity_id}`, {
          method: "PUT",
          body: JSON.stringify(changes),
        }, locTok
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            executed: true,
            opportunity_id: result.opportunity.id,
            name: result.opportunity.name,
            new_status: result.opportunity.status,
            new_stage: result.opportunity.pipelineStageId,
            location_id: activeLocationId,
            audit: `Updated at ${new Date().toISOString()} via ghl-agency-ops-mcp`,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }
);

// ── 9. list_snapshots ─────────────────────────────────────────────────────────
server.tool(
  "list_snapshots",
  "List all snapshots in your agency snapshot library (own, imported, vertical).",
  {
    type: z.enum(["own", "imported", "vertical", "all"]).optional().default("all"),
  },
  async ({ type }) => {
    try {
      const data = await ghl<{ snapshots: GHLSnapshot[] }>(
        `/snapshots/?companyId=${COMPANY_ID}`
      );
      const snapshots = type === "all"
        ? data.snapshots
        : data.snapshots.filter(s => s.type === type);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total: snapshots.length,
            filter: type,
            snapshots: snapshots.map(s => ({
              id: s.id, name: s.name, type: s.type,
              updated_at: s.updatedAt,
            })),
            tip: "Use deploy_snapshot with a snapshot id and target location_id to deploy.",
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }
);

// ── 10. deploy_snapshot ───────────────────────────────────────────────────────
server.tool(
  "deploy_snapshot",
  "Deploy a snapshot to a sub-account. Dry-run by default — preview what will be loaded before applying.",
  {
    snapshot_id:       z.string().describe("Snapshot ID from list_snapshots"),
    target_location_id: z.string().describe("Sub-account to deploy into"),
    snapshot_type:     z.enum(["own", "imported", "vertical"]).optional().default("own"),
    dry_run:           z.boolean().optional().default(true),
  },
  async ({ snapshot_id, target_location_id, snapshot_type, dry_run }) => {
    try {
      // Verify both exist
      const [snapData, locData] = await Promise.all([
        ghl<{ snapshots: GHLSnapshot[] }>(`/snapshots/?companyId=${COMPANY_ID}`),
        ghl<{ location: GHLLocation }>(`/locations/${target_location_id}`),
      ]);

      const snapshot = snapData.snapshots.find(s => s.id === snapshot_id);
      if (!snapshot) throw new Error(`Snapshot ${snapshot_id} not found in agency library.`);
      const loc = locData.location;

      if (dry_run) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify(dryRun({
              snapshot: { id: snapshot.id, name: snapshot.name, type: snapshot.type },
              target_location: { id: loc.id, name: loc.name },
              warning: "Snapshot deployment CANNOT be undone — assets will be added to the sub-account. Verify the target location before confirming.",
              action: "Re-run with dry_run: false to deploy.",
            }), null, 2),
          }],
        };
      }

      // Execute snapshot push
      const result = await ghl<{ success: boolean; message?: string }>(
        `/snapshots/share/link`,
        {
          method: "POST",
          body: JSON.stringify({
            companyId: COMPANY_ID,
            locationId: target_location_id,
            snapshotId: snapshot_id,
            type: snapshot_type,
            shareType: "location",
          }),
        }
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            executed: true,
            snapshot_id, snapshot_name: snapshot.name,
            target_location_id, target_location_name: loc.name,
            result,
            audit: `Deployed at ${new Date().toISOString()} via ghl-agency-ops-mcp`,
            note: "Snapshot assets are now loading into the sub-account. This may take 1–3 minutes.",
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }
);

// ── 11. provision_subaccount ──────────────────────────────────────────────────
server.tool(
  "provision_subaccount",
  "Create a new client sub-account, optionally with a snapshot. Dry-run by default.",
  {
    name:        z.string().describe("Client business name"),
    email:       z.string().describe("Client email"),
    phone:       z.string().optional(),
    address:     z.string().optional(),
    city:        z.string().optional(),
    state:       z.string().optional(),
    country:     z.string().optional().default("US"),
    timezone:    z.string().optional().default("America/New_York"),
    snapshot_id: z.string().optional().describe("Apply this snapshot on creation"),
    snapshot_type: z.enum(["own", "imported", "vertical"]).optional().default("own"),
    dry_run:     z.boolean().optional().default(true),
  },
  async ({ name, email, phone, address, city, state, country, timezone, snapshot_id, snapshot_type, dry_run }) => {
    if (dry_run) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(dryRun({
            will_create: {
              name, email, phone, address, city, state, country, timezone,
              snapshot: snapshot_id ?? null,
            },
            warning: "A new billable sub-account will be created. Verify plan limits before confirming.",
            action: "Re-run with dry_run: false to provision.",
          }), null, 2),
        }],
      };
    }

    try {
      const body: Record<string, unknown> = {
        name, email, phone, address, city, state, country, timezone,
        companyId: COMPANY_ID,
        ...(snapshot_id ? {
          snapshot: { id: snapshot_id, type: snapshot_type },
        } : {}),
      };

      const result = await ghl<{ location: GHLLocation }>("/locations/", {
        method: "POST",
        body: JSON.stringify(body),
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            executed: true,
            new_location_id: result.location.id,
            name: result.location.name,
            snapshot_applied: !!snapshot_id,
            audit: `Provisioned at ${new Date().toISOString()} via ghl-agency-ops-mcp`,
            next_step: `Run switch_location with id: ${result.location.id} to begin working in this sub-account.`,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }
);

// ── 12. cross_location_report ─────────────────────────────────────────────────
server.tool(
  "cross_location_report",
  "Weekly digest across all (or selected) client sub-accounts: contact counts, open opportunities, and pipeline value.",
  {
    location_ids: z.array(z.string()).optional()
      .describe("Specific location IDs to include. Omit for all sub-accounts (max 20)."),
    limit: z.number().int().min(1).max(20).optional().default(10),
  },
  async ({ location_ids, limit }) => {
    try {
      // Get target locations
      let locations: GHLLocation[] = [];
      if (location_ids && location_ids.length > 0) {
        const results = await Promise.all(
          location_ids.map(id =>
            ghl<{ location: GHLLocation }>(`/locations/${id}`)
              .then(d => d.location).catch(() => null)
          )
        );
        locations = results.filter(Boolean) as GHLLocation[];
      } else {
        const data = await ghl<{ locations: GHLLocation[] }>(
          `/locations/search?companyId=${COMPANY_ID}&limit=${limit}`
        );
        locations = data.locations;
      }

      // Fetch stats per location (parallel, graceful degrade)
      const reports = await Promise.all(
        locations.map(async loc => {
          try {
            const locToken = await getLocationToken(loc.id);

            const [contacts, opps] = await Promise.all([
              ghl<{ meta: { total: number } }>(
                `/contacts/?locationId=${loc.id}&limit=1`, {}, locToken
              ).catch(() => ({ meta: { total: 0 } })),
              ghl<{ opportunities: GHLOpportunity[]; meta: { total: number } }>(
                `/opportunities/search?locationId=${loc.id}&status=open&limit=100`, {}, locToken
              ).catch(() => ({ opportunities: [], meta: { total: 0 } })),
            ]);

            const totalValue = opps.opportunities.reduce(
              (sum, o) => sum + (o.monetaryValue ?? 0), 0
            );

            return {
              location_id: loc.id,
              name: loc.name,
              city: loc.city ?? null,
              contacts: contacts.meta?.total ?? 0,
              open_opportunities: opps.meta?.total ?? 0,
              pipeline_value_usd: totalValue,
              status: "ok",
            };
          } catch {
            return {
              location_id: loc.id, name: loc.name,
              status: "error — could not fetch data",
              contacts: null, open_opportunities: null, pipeline_value_usd: null,
            };
          }
        })
      );

      const totalContacts  = reports.reduce((s, r) => s + (r.contacts ?? 0), 0);
      const totalOpps      = reports.reduce((s, r) => s + (r.open_opportunities ?? 0), 0);
      const totalValue     = reports.reduce((s, r) => s + (r.pipeline_value_usd ?? 0), 0);
      const errorCount     = reports.filter(r => r.status !== "ok").length;

      const lines = [
        `# Cross-Location Agency Report`,
        `**Generated:** ${new Date().toISOString()}`,
        `**Sub-accounts included:** ${reports.length} | **Errors:** ${errorCount}`,
        "",
        `## Agency Totals`,
        `  Total contacts:         ${totalContacts.toLocaleString()}`,
        `  Open opportunities:     ${totalOpps.toLocaleString()}`,
        `  Total pipeline value:   $${totalValue.toLocaleString(undefined, { minimumFractionDigits: 0 })}`,
        "",
        `## Per Sub-Account Breakdown`,
        ...reports.map(r =>
          `  ${r.name} (${r.location_id})\n` +
          `    Contacts: ${r.contacts ?? "N/A"} | Open opps: ${r.open_opportunities ?? "N/A"} | Pipeline: $${(r.pipeline_value_usd ?? 0).toLocaleString()} | ${r.status}`
        ),
        "",
        `## Notes`,
        `  • Contact counts are live from GHL API.`,
        `  • Pipeline value sums open opportunities only.`,
        `  • Rate limit: 100 req/10s — report over 20 locations may be slower.`,
      ].join("\n");

      return { content: [{ type: "text", text: lines }] };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ghl-agency-ops-mcp running ✓");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
