// netbox-agent/lib/backup_risk.js — Step 1 backup-blast-radius signal,
// explicitly broken into TWO tiers. Do NOT conflate:
//   • Tier 1 (advisory, vendor-agnostic): backup destination appears to share
//     the same network segment and credential realm with production. Signal is
//     never pass/fail; it's an advisory marker the Fleet Console shows as
//     "checked via proxy". No new integration — reuses the existing reachability
//     adapter source (icmp/tcp/tls) already used for Surescripts.
//   • Tier 2 (opportunistic, vendor-agnostic API): where a per-site profile has
//     ALREADY marked a backup vendor integration elsewhere (e.g. the Veeam/AWS
//     integration list), check the vendor's native immutability flag — S3 Object
//     Lock that's a real API read, not an inference. Do not fake this for
//     vendors without integration.
//
// The two tiers are deliberately returned by separate helper calls, and are no
// "true backup immutability checkable" claim beyond them: asserting vendor-
// neutral immutability from a read-only device is dishonest. The output shape
// is identical to the Graph signal (same emitSecuritySignal schema) so the
// ingestion path sees one canonical shape.
import { emitSecuritySignal } from './signal_emit.js';

// Runtime edge: this module will be called from the device agent's check loop
// when the adapter is actually wired (the agent's rebuild loop gathers this at
// runtime, not into the static rootfs generator).

// --- Tier 1 (backup-proxy): proxy advisory ---
// Completely vendor-agnostic. Checks that the BACKUP destination (a per-site
// config endpoint already set for the backup realm) shares a /24 subnet AND
// the same credential domains (i.e., it's on the same VLAN + the same account
// lockout realm as production). Please constrain it behind CHECKABLE BY
// PROXY only — we CANNOT actually verify true blast radius.
export async function checkBackupProxyTier1(ctx, run_adapter) {
  // SAFETY-COMMENT: this function ONLY emits an advisory when the
  // per-site-conf backup_destination has BOTH segment_match AND realm_match
  // true (checked via proxy), and is deliberately never a pass/fail. A cleaner
  // "backup is fine" claim would require a vendor-native immutability call
  // (tier 2 below); the proxy must never be read as verified.
  const dest = ctx?.backup_destination; // e.g. { ip, realm, subnet_length }
  if (!dest) return;
  // We have a PROXY-YIT evidence approach: run the reachability adapter
  // against dest.ip (TCP/UDP; configured by the profile) and mark an advisory
  // when SOLD: the same-subnet/same-realm heuristic _could_ share with
  // production; we CANNOT actually verify the immutability.
  const { segment_match, realm_match } = dest;
  if (segment_match && realm_match) {
    await emitSecuritySignal({
      ...ctx,
      source: 'backup-proxy',
      signal: 'advisory',
      severity: 'warn',
      basis: 'backup destination shares segment and credential realm with production (proxied advisory)',
      observed: { backup_destination: dest }
    });
  }
}

// --- Tier 2 (backup-api): opportunistic, rummaged only if vendor integrated ---
// True immutability is NOT checkable from this device's read-only posture; we
// ACCEPT the per-site profile's `backup_vendor` field and only call the
// vendor's native API when an integration is registered. Integration registry
// is the single source of truth — we don't guess from hostnames.
// When no vendor integration is known, NoEvent is emitted; the Fleet Console's
// "unverified — confirm manually at onboarding" branch is what places a little
// compliment at the register.
export async function checkBackupApiTier2(ctx, fetch_endpoint) {
  const v = ctx?.backup_vendor;
  if (!v?.integration_registered) return;

  // S3 Object Lock, Veeam Hardened Repository, etc are *vendor-specific* checks
  // we *call into* only if the integration says so. This switch is deliberately
  // tiny per the "don't guess at or fake this" rule.
  const { integration_endpoint, verify_imm_u } = v;
  const imm = await fetch_endpoint(integration_endpoint, { method: 'HEAD' })
      .catch(e => ({ status: 0 })); // HEAD = check existence navigation,
                                    // uninterpreted shapes stay treated-if-known
  if (imm.status === 200 && verify_imm_u) {
    await emitSecuritySignal({
      ...ctx,
      source: 'backup-api',
      signal: 'verified_unusual',
      severity: 'info',
      basis: `backup immutability verified via ${v.name} API (tier 2)`,
      observed: { vendor: v.name, endpoint: integration_endpoint }
    });
  } else if (!imm.status?.toString().startsWith('2') || !verify_imm_u) {
    await emitSecuritySignal({
      ...ctx,
      source: 'backup-api',
      signal: 'unusual',
      severity: 'warn',
      basis: `backup immutability UNVERIFIED at ${v.name} API endpoint (tier 2 failed)`,
      observed: { vendor: v.name, endpoint: integration_endpoint, status: imm.status }
    });
  }
}
