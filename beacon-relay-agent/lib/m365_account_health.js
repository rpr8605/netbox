// beacon-relay-agent/lib/m365_account_health.js
// Responsibility: Phase 1 read-only Microsoft 365 / Entra ID account-health
// visibility (CONTROLS_AND_IDENTITY §4). Uses exactly the four read-only
// scopes the spec names: User.Read.All, AuditLog.Read.All, Organization.Read.All,
// Reports.Read.All. No write actions, no password reset, no unlock, no session
// revocation. Emits a canonical check_result for service `m365_account_health`.
// Called by: ehr_check.js (adapter tag `m365`) and directly by tests.
//
// NOTE: this adapter is built and tested against mocks. A live Entra ID test
// tenant with admin consent is required for real-world validation; that gap is
// logged in `.agent/open-questions.md`.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function tenantConfigured() {
  return Boolean(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

// OAuth2 client-credentials token against the tenant. Reuses the same pattern
// as graph.js so both Graph adapters authenticate identically.
async function acquireToken(fetcher) {
  const url = `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`;
  const body = `client_id=${encodeURIComponent(process.env.MS_CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(process.env.MS_CLIENT_SECRET)}` +
    '&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default' +
    '&grant_type=client_credentials';
  const r = await fetcher('POST', url, body, { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return r.access_token;
}

async function graphGet(fetcher, token, path) {
  return fetcher('GET', `${GRAPH_BASE}${path}`, null, { headers: { authorization: `Bearer ${token}` } });
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600e3).toISOString();
}

// worstStatus — combine sub-statuses into a single service status. Down beats
// degraded beats verified_ready.
function worstStatus(statuses) {
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';
  return 'verified_ready';
}

// runM365AccountHealthCheck — read-only account-health adapter.
// Params:
//   - mockData: optional { organization, signIns, registrationDetails } used by
//     tests to drive the adapter without network or tenant secrets.
// Returns a result object in the same shape as the other EHR adapters so
// ehr_check.js can emit a canonical check_result event.
export async function runM365AccountHealthCheck(params = {}) {
  const { mockData } = params;
  // Without tenant secrets AND without a mock, the adapter is unconfigured.
  if (!mockData && !tenantConfigured()) {
    return { ok: false, status: 'unknown', detail: 'M365 tenant credentials not configured', observed: {} };
  }

  let fetcher;
  let token;
  if (mockData) {
    // Test path: a deterministic mock fetcher that returns the supplied data.
    fetcher = async (_method, url) => {
      if (url.includes('/organization')) return { value: mockData.organization ? [mockData.organization] : [] };
      if (url.includes('/signIns')) return { value: mockData.signIns ?? [] };
      if (url.includes('/credentialUserRegistrationDetails')) return { value: mockData.registrationDetails ?? [] };
      return {};
    };
    token = 'mock-token';
  } else {
    fetcher = defaultFetch;
    token = await acquireToken(fetcher);
  }

  // 1. Organization / directory sync health (Organization.Read.All).
  const orgData = await graphGet(fetcher, token, '/organization?$select=id,displayName,onPremisesSyncEnabled,onPremisesLastSyncDateTime');
  const org = orgData.value?.[0] ?? {};
  const syncEnabled = org.onPremisesSyncEnabled === true;
  const lastSync = org.onPremisesLastSyncDateTime ? Date.parse(org.onPremisesLastSyncDateTime) : null;
  const syncStaleHours = lastSync ? Math.round((Date.now() - lastSync) / 3600e3) : null;
  let syncStatus = 'verified_ready';
  let syncDetail = syncEnabled ? `AD Connect sync healthy (${syncStaleHours}h ago)` : 'cloud-native tenant (no AD Connect sync)';
  if (syncEnabled && syncStaleHours != null) {
    if (syncStaleHours > 72) { syncStatus = 'down'; syncDetail = `AD Connect sync stale (${syncStaleHours}h ago)`; }
    else if (syncStaleHours > 24) { syncStatus = 'degraded'; syncDetail = `AD Connect sync lagging (${syncStaleHours}h ago)`; }
  }

  // 2. Sign-in failure spikes (AuditLog.Read.All).
  // Filter to failures in the last 24 hours. In a real tenant this is a
  // lightweight read; no user secrets or raw credentials are returned.
  const since = hoursAgo(24);
  const signInData = await graphGet(fetcher, token, `/auditLogs/signIns?$filter=createdDateTime ge ${since}&$top=50`);
  const signIns = signInData.value ?? [];
  const failures = signIns.filter(r => r.status?.errorCode !== 0 && r.status?.errorCode != null);
  let failureStatus = 'verified_ready';
  let failureDetail = `${failures.length} sign-in failure(s) in last 24h`;
  if (failures.length > 50) { failureStatus = 'down'; failureDetail = `critical sign-in failure spike (${failures.length})`; }
  else if (failures.length > 10) { failureStatus = 'degraded'; failureDetail = `elevated sign-in failures (${failures.length})`; }

  // 3. MFA / credential registration gaps (Reports.Read.All).
  const regData = await graphGet(fetcher, token, '/reports/credentialUserRegistrationDetails?$top=50');
  const regs = regData.value ?? [];
  const mfaEnabledCount = regs.filter(r => r.isMfaRegistered === true || r.methodsRegistered?.includes('microsoftAuthenticatorPush')).length;
  const mfaGapPercent = regs.length ? Math.round(((regs.length - mfaEnabledCount) / regs.length) * 100) : 0;
  let mfaStatus = 'verified_ready';
  let mfaDetail = `MFA gap ${mfaGapPercent}% (${regs.length} users sampled)`;
  if (mfaGapPercent > 60) { mfaStatus = 'down'; mfaDetail = `critical MFA gap ${mfaGapPercent}%`; }
  else if (mfaGapPercent > 30) { mfaStatus = 'degraded'; mfaDetail = `high MFA gap ${mfaGapPercent}%`; }

  const overallStatus = worstStatus([syncStatus, failureStatus, mfaStatus]);
  const ok = overallStatus === 'verified_ready';

  return {
    ok,
    status: overallStatus,
    detail: [syncDetail, failureDetail, mfaDetail].join('; '),
    observed: {
      tenant_display_name: org.displayName ?? null,
      ad_connect_enabled: syncEnabled,
      ad_connect_last_sync_hours_ago: syncStaleHours,
      sign_in_failure_count_24h: failures.length,
      mfa_gap_percent: mfaGapPercent,
      users_sampled: regs.length,
    },
  };
}

// Default REST helper. Mirrors graph.js: form-encoded token POST, JSON GET.
async function defaultFetch(method, url, body, headers = {}) {
  const isForm = typeof body === 'string' && method === 'POST';
  const res = await fetch(url, {
    method,
    headers: isForm
      ? { 'content-type': 'application/x-www-form-urlencoded', ...headers.headers }
      : headers.headers,
    body: isForm ? body : undefined,
  });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

// Re-export for tests that want to assert tenantConfigured directly.
export { tenantConfigured };
