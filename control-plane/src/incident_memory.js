// control-plane/src/incident_memory.js
// Responsibility: deterministic, evidence-linked troubleshooting memory
// (TOPOLOGY_AND_TROUBLESHOOTING_MEMORY.md §2). No LLM, no generated narration —
// a plain weighted-overlap score over structured past incidents, with every
// suggestion linked to the real past cases it matched.
import { allClosedIncidents } from './db.js';

// bucket hour into the three buckets the spec names.
function timeBucket(hour) {
  if (hour >= 6 && hour < 18) return 'business-hours';
  if (hour >= 18 && hour < 22) return 'after-hours';
  return 'overnight';
}

// scoreSignature — hand-tracable weighted overlap between a new incident
// signature and one closed past incident. Returns { score, matchedOn }.
export function scoreSignature(newSig, past) {
  let score = 0;
  const matchedOn = [];

  // Highest weight: exact service + vendor + status_transition.
  if (newSig.service === past.service &&
      (newSig.vendor ?? 'unknown') === (past.vendor ?? 'unknown') &&
      newSig.status_transition === past.status_transition) {
    score += 10;
    matchedOn.push('service+vendor+status_transition');
  }
  // Medium weight: service + status_transition (different vendor ok).
  else if (newSig.service === past.service && newSig.status_transition === past.status_transition) {
    score += 6;
    matchedOn.push('service+status_transition');
  }

  // Co-occurring signals overlap adds weight but never stands alone.
  const newCooc = new Set(JSON.parse(newSig.co_occurring_signals ?? '[]'));
  const pastCooc = JSON.parse(past.co_occurring_signals ?? '[]');
  const overlap = pastCooc.filter(s => newCooc.has(s));
  if (overlap.length) {
    score += overlap.length * 2;
    matchedOn.push(`co_occurring_signals:${overlap.join(',')}`);
  }

  // Small bonus for same time-of-day bucket and interface engine — informative,
  // but deliberately weaker than service/transition.
  if (newSig.time_of_day_bucket === past.time_of_day_bucket) {
    score += 1;
    matchedOn.push('time_of_day_bucket');
  }
  if ((newSig.interface_engine ?? 'none') === (past.interface_engine ?? 'none') &&
      (newSig.interface_engine ?? 'none') !== 'none') {
    score += 1;
    matchedOn.push('interface_engine');
  }

  return { score, matchedOn };
}

// findSimilarIncidents — ranked list of closed past incidents for a new
// signature. Includes a link (alert_id) to each matched incident so a human can
// verify. Returns [] when nothing clears the threshold (cold-start honesty).
export async function findSimilarIncidents(newSig, { threshold = 4, topN = 5, excludeAlertId = null } = {}) {
  const past = (await allClosedIncidents()).filter(p => p.alert_id !== excludeAlertId);
  const scored = past
    .map(p => ({ ...p, ...scoreSignature(newSig, p) }))
    .filter(p => p.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  // Aggregate root-cause and action distributions across matches.
  const rootCauses = {};
  const actions = {};
  let totalResolveMin = 0;
  let resolveCount = 0;
  for (const p of scored) {
    if (p.root_cause_category) {
      rootCauses[p.root_cause_category] = (rootCauses[p.root_cause_category] ?? 0) + 1;
    }
    if (p.action_taken) {
      actions[p.action_taken] = (actions[p.action_taken] ?? 0) + 1;
    }
    if (p.time_to_resolve_min != null) {
      totalResolveMin += p.time_to_resolve_min;
      resolveCount++;
    }
  }

  return {
    matches: scored.map(p => ({
      alert_id: p.alert_id,
      score: p.score,
      matched_on: p.matchedOn,
      service: p.service,
      status_transition: p.status_transition,
      vendor: p.vendor,
      interface_engine: p.interface_engine,
      root_cause_category: p.root_cause_category,
      action_taken: p.action_taken,
      time_to_resolve_min: p.time_to_resolve_min,
      closed_at: p.closed_at,
    })),
    summary: {
      count: scored.length,
      root_cause_distribution: rootCauses,
      action_distribution: actions,
      median_time_to_resolve_min: resolveCount ? Math.round(totalResolveMin / resolveCount) : null,
    },
  };
}

// capture helper: compute the three time-of-day buckets from an ISO timestamp.
export { timeBucket };
