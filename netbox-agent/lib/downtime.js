// netbox-agent/lib/downtime.js
// Responsibility: downtime mode (spec §3) — the one piece of the product that
// must work ESPECIALLY when the WAN and the cloud dashboard are both down. A
// tiny local HTTP server on the device serves the cached contact tree, vendor
// numbers, per-site recovery priorities, and runbooks straight from /data.
// Called by: the agent daemon on boot; refreshed whenever the control plane
// answers; served locally regardless of WAN state.
//
// SAFETY: serves ONLY from the local cache — never proxies to the control
// plane, so a severed WAN can't make the downtime UI itself hang. Cache is
// read fresh per request so a post-recovery refresh is visible immediately.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const CACHE_PATH = process.env.NETBOX_DOWNTIME_CACHE || '/data/downtime_cache.json';

// Seed the cache from the control plane when reachable. Failure is non-fatal:
// downtime mode exists precisely for when this call can't complete.
export async function refreshDowntimeCache({ cacheGet }) {
  const bundle = await cacheGet(); // injected fetcher (device-authenticated)
  if (bundle && bundle.site_id) {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ ...bundle, cached_at: new Date().toISOString() }));
    return true;
  }
  return false;
}

// Read the current cache. An absent/corrupt cache returns a clear empty shape
// — the UI must render SOMETHING even if nothing was ever cached.
export function readDowntimeCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
  catch { return { site_id: null, contacts: [], vendors: [], recovery_priorities: [], runbooks: [], cached_at: null, empty: true }; }
}

// renderDowntimeHtml — static, dependency-free HTML. Deliberately no JS
// framework: this page must render on any browser that can reach the box,
// on a device with no npm tree and possibly no WAN for CDN assets.
export function renderDowntimeHtml(bundle) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = (items, cols) => (items ?? []).map(i =>
    `<tr>${cols.map(c => `<td>${esc(i[c])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}"><em>none cached</em></td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Netbox Downtime Mode</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#17202a}table{border-collapse:collapse;width:100%;margin-bottom:1.5rem}
th,td{border:1px solid #ccd;padding:6px 10px;text-align:left;font-size:14px}th{background:#f4f6f8}
h1{border-bottom:2px solid #b03a2e}h2{color:#1a5276}.stale{color:#b26a00}</style></head><body>
<h1>Netbox — Downtime Mode</h1>
<p>Served locally from this appliance. Works when the WAN and cloud dashboard are unreachable.
${bundle.cached_at ? `Cache refreshed: ${esc(bundle.cached_at)}` : '<span class="stale">No cache yet — connect the appliance once to populate.</span>'}</p>
<h2>Contact tree</h2><table><thead><tr><th>Role</th><th>Name</th><th>Contact</th></tr></thead><tbody>${rows(bundle.contacts, ['role', 'name', 'contact'])}</tbody></table>
<h2>Vendor numbers</h2><table><thead><tr><th>Vendor</th><th>Support #</th><th>Account</th></tr></thead><tbody>${rows(bundle.vendors, ['vendor', 'support_number', 'account'])}</tbody></table>
<h2>Recovery priorities</h2><table><thead><tr><th>Order</th><th>Service</th><th>Note</th></tr></thead><tbody>${rows(bundle.recovery_priorities, ['order', 'service', 'note'])}</tbody></table>
<h2>Runbooks</h2><table><thead><tr><th>Condition</th><th>Runbook</th></tr></thead><tbody>${rows(bundle.runbooks, ['condition', 'runbook'])}</tbody></table>
</body></html>`;
}

// Start the local server. Returns the http.Server so the caller/tests can
// close it. Binds 127.0.0.1 by default (the device-local admin page); a site
// LAN bind is a deliberate, separately-justified choice.
export function startDowntimeServer({ port = 8081, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    const bundle = readDowntimeCache();
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(renderDowntimeHtml(bundle));
  });
  return new Promise(resolve => server.listen(port, host, () => resolve(server)));
}
