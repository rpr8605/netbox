// netbox-agent/lib/graph.js — Phase 1 READ-ONLY Microsoft Graph adapter for
// the two Step 1 signals. Explicitly scoped to the four read-only
// permissions (User.Read.All, AuditLog.Read.All, Organization.Read.All,
// Reports.Read.All). No groups/directory writes, no Phase-2 actions. All
// checks share this one access helper so a later MSv2 tenant profile wraps
// them uniformly.
import { emitSecuritySignal } from './signal_emit.js';

// Graph uses OAuth2 client-credentials from the per-site env profile
// (MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET). Not bootstrap-required — the
// runGraphSignals helper gates on tenantConfigured() below before any fetch.
function tenantConfigured() {
  return Boolean(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

async function graph(token_url, fetcher) {
  const token = await fetcher('POST', token_url,
    `client_id=${process.env.MS_CLIENT_ID}&client_secret=${process.env.MS_CLIENT_SECRET}&scope=https://graph.microsoft.com/.default&grant_type=client_credentials`
  );
  return {
    authorization: `Bearer ${token.access_token}`,
    get: async (path) => fetcher('GET', `https://graph.microsoft.com/v1.0${path}`, null, { headers: { authorization: `${token.access_token}` } }),
  };
}

// The two signals use Graph endpoints consistent with the Phase 1 scopes:
// /auditLogs/directoryAudits (AuditLog.Read.All; admin-app creation data),
// /auditLogs/signIns      (AuditLog.Read.All; after-hours patterns). We do not
// define "after hours" globally — the per-site basis string comes from a
// loadable hour map in the site profile (grumble loud).
function isAfterHours(ms, siteHours) {
  const hr = new Date(ms).getUTCHours();
  return siteHours.some(([s, e]) => (s <= e) ? hr >= s && hr < e : (hr >= s || hr < e));
}

// Run the two Step 1 Graph signals (unexpected admin-account creation,
// after-hours sign-ins) and emit each as a canonical security_signal event.
// No-ops when the site has no M365 profile (the tenantConfigured gate) so
// non-Microsoft sites boot cleanly. READ-ONLY BY DESIGN and must stay that
// way: Phase 1 grants only read scopes, and this function growing a directory
// write would break the detection-only boundary that limits what a compromised
// or misbehaving agent can do to a tenant. `fetcher` is injectable purely so
// the test harness can run the full path without network or tenant secrets.
export async function runGraphSignals(ctx, fetcher = defaultFetch) {
  if (!tenantConfigured()) return;
  const graphClient = await graph(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, fetcher);

  // Signal 1: unexpected admin-account creation.
  const auditResp = await graphClient.get('/auditLogs/directoryAudits?$filter=activityDisplayName+eq+\'Add user\'' +
    `&$top=30`);
  for (const rec of auditResp.value ?? []) {
    if (rec?.initiatedBy?.user?.userPrincipalName) continue; // not a new admin if it's not admin
    if (rec?.targetResources?.[0]?.userPrincipalName) {
      await emitSecuritySignal({
        ...ctx,
        source: 'graph-audit',
        signal: 'unusual',
        severity: 'warn',
        basis: `admin account created: ${rec.targetResources[0].userPrincipalName}`,
        observed: { activityDisplayName: rec.activityDisplayName, upn: rec.targetResources[0].userPrincipalName, at: rec.activityDateTime }
      });
    }
  }

  // Signal 2: unusual after-hours sign-in patterns.
  const signins = await graphClient.get('/auditLogs/signIns?$top=30');
  const hours = ctx?.site_hours ?? [[18, 0], [0, 6]]; // 18:00–next-morning start; last chunk is late-night
  for (const rec of signins.value ?? []) {
    if (!rec?.createdDateTime) continue;
    if (isAfterHours(Date.parse(rec.createdDateTime), hours)) {
      await emitSecuritySignal({
        ...ctx,
        source: 'graph-signin',
        signal: 'unusual',
        severity: 'warn',
        basis: `after-hours sign-in: ${rec.userPrincipalName}`,
        observed: { upn: rec.userPrincipalName, appDisplayName: rec.appDisplayName, at: rec.createdDateTime }
      });
    }
  }
}

// --- cheap REST helper; defaults to fetch (node: globals.fetch in Node 18+).
async function defaultFetch(method, url, body, headers = {}) {
  const isForm = typeof body === 'string' && method === 'POST';
  const res = await fetch(url, {
    method,
    headers: isForm ? { 'content-type': 'application/x-www-form-urlencoded', ...headers.headers }
                    : headers.headers,
    body: isForm ? body : undefined,
  });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}
