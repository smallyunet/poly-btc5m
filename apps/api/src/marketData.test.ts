import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreChop } from './marketData';

test('does not reward range beyond the minimum activity gate', () => {
  const base = {
    cross120s: 3,
    rangeBps120s: 3,
    minBiExcursionBps120s: 2,
    excursionBalance120s: 1,
    driftRatio120s: 0.2,
    momentumRatio30s: 0.12,
    rangePercentile120s: null,
  };

  assert.equal(scoreChop({ ...base, rangeBps120s: 30 }), scoreChop(base));
});

test('penalizes one-sided excursion even when total range is large', () => {
  const balanced = scoreChop({
    cross120s: 3,
    rangeBps120s: 10,
    minBiExcursionBps120s: 2,
    excursionBalance120s: 1,
    driftRatio120s: 0.2,
    momentumRatio30s: 0.12,
    rangePercentile120s: null,
  });
  const oneSided = scoreChop({
    cross120s: 3,
    rangeBps120s: 10,
    minBiExcursionBps120s: 0.4,
    excursionBalance120s: 0.08,
    driftRatio120s: 0.2,
    momentumRatio30s: 0.12,
    rangePercentile120s: null,
  });

  assert.ok(balanced - oneSided >= 30);
});
