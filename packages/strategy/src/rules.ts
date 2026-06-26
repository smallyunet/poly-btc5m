import type { StrategyRule } from '../../shared/src';

export const STRATEGY_RULES: StrategyRule[] = [
  {
    id: 'BTC5M_DUAL_45',
    title: 'BTC 5m Dynamic Dual Pre-Round',
    allocationPct: 1,
    summary: 'Pre-commit YES and NO liquidity with score-based limit pricing and conservative score-based sizing when the next round looks choppy.',
    entryRules: [
      'Round must be inside the T-30s decision window before start.',
      'Regime must be CHOP: BTC path score, cross_120s, range, two-sided excursion, drift ratio, and momentum ratio filters all pass.',
      'YES and NO books must be live, fresh, and buyable for the configured limit to be valid.',
      'Shares are score-tiered: low CHOP scores reduce size, mid scores use base size, and very high scores get only a small size increase.',
      'No duplicate local or Polymarket open order may exist for the same round/token.',
    ],
    exitRules: [
      'If both sides fill, hold paired exposure through settlement.',
      'If only one side fills, a separate last-window hedge rule may buy the missing side with a capped aggressive limit order.',
      'Outside the configured single-fill hedge window, the bot does not add, sell, or rebalance after the round starts.',
      'Execution rejects all SELL intents and rejects normal entry intents after round start; hedge intents use the separate capped hedge gate.',
    ],
  },
  {
    id: 'BTC5M_SINGLE_FILL_HEDGE',
    title: 'BTC 5m Single-Fill Stop-Loss Hedge',
    allocationPct: 0,
    summary: 'In the final seconds of an active round, cancel stale missing-side entry orders and buy the missing side only if the live ask stays below the configured hedge cap.',
    entryRules: [
      'Round must already be running and inside SINGLE_FILL_HEDGE_WINDOW_SECONDS, but not inside SINGLE_FILL_HEDGE_MIN_SECONDS_TO_END.',
      'Exactly one side must have more BUY fills than the other side by at least the minimum order size.',
      'The missing-side orderbook must be live, fresh, and have bestAsk <= SINGLE_FILL_HEDGE_MAX_PRICE.',
      'Dominant-side average fill price plus hedge limit price must be <= SINGLE_FILL_HEDGE_MAX_PAIR_COST.',
      'The hedge is posted as a capped BUY LIMIT order, not an uncapped market order.',
    ],
    exitRules: [
      'No SELL hedge is generated.',
      'If the cap is exceeded, the bot leaves the single-sided exposure open through settlement.',
    ],
  },
];
