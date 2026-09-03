// netbox-agent/lib/net_checks.js
// Responsibility: generic network checks — adapter #3 of the EHR/EMR layer
// (EHR spec §2): L0 ICMP reachability, L1 TCP port, L2 TLS handshake/certificate
// validity. Reused as-is against whatever host:port a site's EHR, interface
// engine, or pharmacy gateway lives at. Vendor-agnostic by design; the per-site
// config profile points it at real endpoints.
// Called by: ehr_check.js (check dispatch), and directly by fhir_r4.js /
// mirth_admin.js for their L1/L2 preambles.
//
// IMAGE CONSTRAINT: node builtins only (agent.js header). ICMP ping has no
// stdlib API on any OS, so it shells out — and the device image does not ship
// iputils-ping (30-agent.sh package list). Failure mode is therefore HONEST:
// L0 reports skipped:true rather than faking reachability.
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';

// L0 — ICMP echo via the system ping binary. Returns ok:false+skipped:true
// when no ping binary exists (device image ships none) so the orchestrator
// can distinguish "host silent" from "we never asked". Windows vs Linux flag
// differ; both are handled.
export function ping(host, timeoutMs = 2000) {
  const win = process.platform === 'win32';
  const args = win
    ? ['-n', '1', '-w', String(Math.ceil(timeoutMs))]
    : ['-c', '1', '-W', String(Math.ceil(timeoutMs / 1000))];
  try {
    const started = Date.now();
    execFileSync('ping', [...args, host], { stdio: 'pipe' });
    return { ok: true, skipped: false, latency_ms: Date.now() - started };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, skipped: true, detail: 'ping binary absent on this host/image' };
    return { ok: false, skipped: false, detail: 'no ICMP reply' };
  }
}

// L1 — plain TCP connect with a hard timeout. Transport refusal/timeout is a
// result (ok:false), never a throw: one dead endpoint must not abort the run.
export function tcpCheck(host, port, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => {
      sock.destroy();
      resolve({ ok: true, latency_ms: Date.now() - started });
    });
    sock.once('timeout', () => { sock.destroy(); resolve({ ok: false, detail: 'tcp timeout', latency_ms: timeoutMs }); });
    sock.once('error', e => resolve({ ok: false, detail: String(e.code ?? e.message ?? e), latency_ms: Date.now() - started }));
    sock.connect(port, host);
  });
}

// L2 — TLS handshake + peer-certificate VALIDITY-WINDOW check. Deliberately
// rejectUnauthorized:false (same stance as http_json.js header): site-local
// endpoints are self-signed or private-CA, so chain-of-trust is not available;
// what IS checked is that a TLS endpoint actually answers, presents a cert,
// and that the cert is within its validity window — which catches the two
// real-world failure classes (service down/replaced, expired cert) without
// pretending to a CA trust we don't have. cert identity + expiry are reported
// in observed, so the console can show "cert expires in N days".
export function tlsCheck(host, port, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise(resolve => {
    // Skip SNI for literal IPs: RFC 6066 forbids IP literals in servername and
    // hospital endpoints are routinely addressed by IP in site profiles.
    const isIp = net.isIP(host);
    const sock = tls.connect({ host, port, servername: isIp ? undefined : host, rejectUnauthorized: false, timeout: timeoutMs });
    sock.once('secureConnect', () => {
      const cert = sock.getPeerCertificate(true);
      const certInfo = cert && typeof cert === 'object' ? {
        subject: cert.subject?.CN ?? null,
        issuer: cert.issuer?.CN ?? null,
        valid_from: cert.valid_from ?? null,
        valid_to: cert.valid_to ?? null,
      } : null;
      sock.end();
      if (!certInfo) return resolve({ ok: false, detail: 'no peer certificate presented', latency_ms: Date.now() - started });
      const now = Date.now();
      const validTo = certInfo.valid_to ? Date.parse(certInfo.valid_to) : null;
      const validFrom = certInfo.valid_from ? Date.parse(certInfo.valid_from) : null;
      if (validTo != null && now > validTo) {
        return resolve({ ok: false, detail: `certificate expired (${certInfo.valid_to})`, cert: certInfo, latency_ms: Date.now() - started });
      }
      if (validFrom != null && now < validFrom) {
        return resolve({ ok: false, detail: `certificate not yet valid (${certInfo.valid_from})`, cert: certInfo, latency_ms: Date.now() - started });
      }
      resolve({ ok: true, cert: certInfo, latency_ms: Date.now() - started });
    });
    sock.once('timeout', () => { sock.destroy(); resolve({ ok: false, detail: 'tls handshake timeout', latency_ms: timeoutMs }); });
    sock.once('error', e => resolve({ ok: false, detail: String(e.code ?? e.message ?? e), latency_ms: Date.now() - started }));
  });
}

// hostPortFromUrl('https://ehr.example/fhir/r4') -> { host, port, isHttps }.
// Centralized so a malformed profile URL is one error, not three adapters
// each parsing differently.
export function hostPortFromUrl(urlStr) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  return { host: u.hostname, port: u.port ? Number(u.port) : (isHttps ? 443 : 80), isHttps };
}

// runNetCheck — the generic "is this host:port alive and how far" check.
// Status mapping (kept here so every consumer maps L1/L2 identically):
//   L1 fail                          -> 'down'      (tier_observed: last-good tier or null)
//   L1 ok + tls requested, L2 fail   -> 'degraded'  (port alive, TLS unhealthy — a real
//                                                    partial failure class, not an outage)
//   L1 ok + tls requested, L2 ok     -> 'verified_ready' (tier 'L2')
//   L1 ok, no tls requested          -> 'reachable' (tier 'L1')
// L0 is probed best-effort first and only annotates; it never gates — the
// image ships no ping binary and many sites block ICMP anyway.
export async function runNetCheck({ host, port, tls: wantTls = false }) {
  const started = Date.now();
  const pingRes = ping(host);
  const l1 = await tcpCheck(host, port);
  if (!l1.ok) {
    return {
      ok: false, tier: null, status: 'down',
      latency_ms: Date.now() - started,
      detail: `TCP ${host}:${port} unreachable (${l1.detail ?? 'no connect'})`,
      observed: { l0: pingRes.skipped ? 'skipped' : (pingRes.ok ? 'ok' : 'fail'), l1: 'fail' },
    };
  }
  if (wantTls) {
    const l2 = await tlsCheck(host, port);
    if (!l2.ok) {
      return {
        ok: false, tier: 'L1', status: 'degraded',
        latency_ms: Date.now() - started,
        detail: `TLS unhealthy on ${host}:${port} (${l2.detail ?? 'handshake failed'})`,
        observed: { l0: pingRes.skipped ? 'skipped' : (pingRes.ok ? 'ok' : 'fail'), l1: 'ok', l2: 'fail' },
      };
    }
    return {
      ok: true, tier: 'L2', status: 'verified_ready',
      latency_ms: Date.now() - started,
      detail: `TLS ok on ${host}:${port}; cert CN=${l2.cert?.subject ?? '?'} valid_to=${l2.cert?.valid_to ?? '?'}`,
      observed: { l0: pingRes.skipped ? 'skipped' : (pingRes.ok ? 'ok' : 'fail'), l1: 'ok', l2: 'ok', cert: l2.cert },
    };
  }
  return {
    ok: true, tier: 'L1', status: 'reachable',
    latency_ms: Date.now() - started,
    detail: `TCP ${host}:${port} open (cleartext endpoint; no TLS to verify)`,
    observed: { l0: pingRes.skipped ? 'skipped' : (pingRes.ok ? 'ok' : 'fail'), l1: 'ok' },
  };
}
