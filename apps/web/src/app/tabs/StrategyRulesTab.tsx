import type { DashboardState } from '../../../../../packages/shared/src';

type Props = {
  rules: DashboardState['rules'];
};

export function StrategyRulesTab({ rules }: Props) {
  return (
    <div className="panel">
      <h2>Trading Strategy & Configured Rules</h2>
      <div className="rulesGrid">
        {rules && rules.length > 0 ? (
          rules.map((rule) => (
            <div key={rule.id} className="ruleCard">
              <div className="ruleHeader">
                <span className="ruleTitle">{rule.title} ({rule.id})</span>
                <span className="ruleAllocation">{rule.allocationPct}% ALLOCATION</span>
              </div>
              <p className="ruleSummary">{rule.summary}</p>
              <div className="ruleLists">
                <div className="ruleSection">
                  <h4>Entry triggers</h4>
                  <ul>
                    {rule.entryRules.map((entry, idx) => (
                      <li key={idx}>{entry}</li>
                    ))}
                  </ul>
                </div>
                <div className="ruleSection">
                  <h4>Exit parameters</h4>
                  <ul>
                    {rule.exitRules.map((exit, idx) => (
                      <li key={idx}>{exit}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="empty" style={{ width: '100%' }}>
            <p className="emptyText">No strategy rules loaded in bot configuration</p>
          </div>
        )}
      </div>
    </div>
  );
}
