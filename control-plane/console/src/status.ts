export type UiStatus = 'working' | 'degraded' | 'down' | 'nodata' | 'notmonitored';

export interface StatusMapping {
  ui: UiStatus;
  label: string;
  glyph: string;
}

/**
 * Map a canonical event status to a single UI status vocabulary.
 * See docs/specs/BEACON_RELAY_TECH_CONSOLE_SPEC.md §3.
 */
export function mapStatus(status: string | undefined): StatusMapping {
  switch (status) {
    case 'active':
    case 'verified_ready':
    case 'reachable':
      return { ui: 'working', label: 'Working', glyph: '' };
    case 'degraded':
      return { ui: 'degraded', label: 'Degraded', glyph: '~' };
    case 'down':
      return { ui: 'down', label: 'Down', glyph: '!' };
    case 'notmonitored':
      return { ui: 'notmonitored', label: 'Not monitored', glyph: '·' };
    case 'unknown':
    default:
      return { ui: 'nodata', label: 'No data', glyph: '?' };
  }
}

/** Threshold in ms after which a device's services are considered stale. */
export const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Apply staleness and not-monitored rules to a raw service status.
 * - If the last report is older than STALE_THRESHOLD_MS, return 'nodata'.
 * - If the service is explicitly not monitored, return 'notmonitored'.
 */
export function resolveServiceStatus(
  status: string | undefined,
  options: { lastReportAt?: string; monitored?: boolean } = {},
): StatusMapping {
  if (options.monitored === false) {
    return mapStatus('notmonitored');
  }
  if (options.lastReportAt) {
    const last = new Date(options.lastReportAt).getTime();
    if (Date.now() - last > STALE_THRESHOLD_MS) {
      return mapStatus('unknown');
    }
  }
  return mapStatus(status);
}
