import type { RuntimeLogRecord } from '../../../packages/shared/src';

const EXPECTED_DUPLICATE_GUARD = /^Paper execution blocked for (YES|NO): LOCAL_STRATEGY_ORDER_EXISTS\.$/;

export function tickLogLevel(diagnostics: string[]): RuntimeLogRecord['level'] {
  const actionable = diagnostics.some((diagnostic) => (
    !EXPECTED_DUPLICATE_GUARD.test(diagnostic)
    && /failed|stale|blocked|error/i.test(diagnostic)
  ));
  return actionable ? 'warn' : 'info';
}
