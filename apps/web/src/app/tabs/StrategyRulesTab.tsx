import type { DashboardState } from '../../../../../packages/shared/src';

type Props = {
  rules: DashboardState['rules'];
};

export const PAPER_VISIBLE_STRATEGY_IDS = new Set([
  'UPDOWN_DUAL_ENTRY',
  'UPDOWN_TAIL_ENTRY',
  'UPDOWN_NEXT_ROUND_50_49_STOP_ON_SINGLE',
]);

export function StrategyRulesTab({ rules }: Props) {
  const paperRules = rules.filter((rule) => PAPER_VISIBLE_STRATEGY_IDS.has(rule.id));

  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <span className="sectionKicker">Paper experiment scope</span>
          <h2>Active Paper Strategies</h2>
        </div>
        <span className="panelSubTitle">{paperRules.length} visible</span>
      </div>
      <div className="rulesGrid">
        {paperRules.length > 0 ? (
          paperRules.map((rule) => (
            <div key={rule.id} className="ruleCard">
              <div className="ruleHeader">
                <span className="ruleTitle">{rule.title} ({rule.id})</span>
                <span className="ruleAllocation">PAPER</span>
              </div>
              <p className="ruleSummary">{rule.summary}</p>
              <p className="ruleSummary">Current gates, selected prices, and blockers are reported in Overview for each profile.</p>
            </div>
          ))
        ) : (
          <div className="empty" style={{ width: '100%' }}>
            <p className="emptyText">No paper strategy rules loaded in this run</p>
          </div>
        )}
      </div>
    </div>
  );
}
