import type { CircularTradingReport } from '../../listener/src/circular-trading-report.js';
import type { ReportDeliveryOutcome } from './report-receiver.js';

/**
 * Delivers a stored report to a downstream HTTP endpoint. 2xx is delivered; 408, 425, 429, 5xx and network problems are
 * retryable; every other status is a permanent refusal that is not retried. Redirects are refused.
 */
export function httpReportDelivery(url: string, fetchFn: typeof fetch = globalThis.fetch, timeoutMs = 10_000): (report: CircularTradingReport) => Promise<ReportDeliveryOutcome> {
  return async (report) => {
    let response: Response;
    try {
      response = await fetchFn(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    } catch {
      return 'retryable';
    }
    if (response.ok) return 'delivered';
    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) return 'retryable';
    return 'permanent';
  };
}
