import React from 'react';

interface PriceStrikeGaugeProps {
  btcPrice: number;
  centerPrice: number | null;
  rangeBps120s: number;
  volatility120s: number;
  centerMinBiExcursionBps120s: number;
  centerExcursionBalance120s: number;
  latestRangePosition120s: number | null;
  minRangeBps120s?: number;
  highRangeBps120s?: number;
}

export const PriceStrikeGauge: React.FC<PriceStrikeGaugeProps> = ({
  btcPrice,
  centerPrice,
  rangeBps120s,
  volatility120s,
  centerMinBiExcursionBps120s,
  centerExcursionBalance120s,
  latestRangePosition120s,
  minRangeBps120s = 3,
  highRangeBps120s = 12,
}) => {
  const polarToCartesian = (centerX: number, centerY: number, radius: number, angleInDegrees: number) => {
    const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
    return {
      x: centerX + radius * Math.cos(angleInRadians),
      y: centerY + radius * Math.sin(angleInRadians),
    };
  };

  const describeArc = (x: number, y: number, radius: number, startAngle: number, endAngle: number) => {
    const start = polarToCartesian(x, y, radius, endAngle);
    const end = polarToCartesian(x, y, radius, startAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
    return [
      'M', start.x, start.y,
      'A', radius, radius, 0, largeArcFlag, 0, end.x, end.y,
    ].join(' ');
  };

  const formatMoney = (value: number) => `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const formatNumber = (value: number, digits = 2) => value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

  const center = 50;
  const radius = 38;
  const rangeRatio = highRangeBps120s > 0 ? clamp(rangeBps120s / highRangeBps120s, 0, 1) : 0;
  const angleDegrees = -135 + rangeRatio * 270;
  const activeFillPath = describeArc(center, center, radius, -135, angleDegrees);
  const isTradableActivity = rangeBps120s >= minRangeBps120s;
  const isHighVol = rangeBps120s >= highRangeBps120s;
  const activeZoneClass = isTradableActivity && !isHighVol ? 'above' : 'below';
  const statusText = isHighVol
    ? 'HIGH RANGE'
    : isTradableActivity ? 'ACTIVE RANGE' : 'LOW RANGE';
  const rangePositionLabel = latestRangePosition120s == null
    ? 'unknown'
    : `${formatNumber(latestRangePosition120s * 100, 1)}% of 120s range`;

  return (
    <div className="priceStrikeGaugeWrapper">
      <div className="gaugeCockpitContainer">
        <div className="gaugeCockpitHeader">
          <div className="gaugeTelemetryItem">
            <span>BTC Price</span>
            <strong>{formatMoney(btcPrice)}</strong>
          </div>
          <div className="gaugeStatusBadge">
            <span className={`pulseDot ${activeZoneClass}`}></span>
            <span className="statusText">{statusText}</span>
          </div>
          <div className="gaugeTelemetryItem text-right">
            <span>120s Center</span>
            <strong>{centerPrice == null ? 'unknown' : formatMoney(centerPrice)}</strong>
          </div>
        </div>

        <div className="gaugeDialFrame">
          <svg viewBox="0 0 100 75" className="gaugeDialSvg">
            <defs>
              <linearGradient id="volatilityActiveGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="var(--color-primary)" />
                <stop offset="55%" stopColor="var(--color-success)" />
                <stop offset="100%" stopColor="var(--color-danger)" />
              </linearGradient>
            </defs>

            <path
              d={describeArc(center, center, radius, -135, 0)}
              className="gaugeZoneTrack down"
              strokeWidth="4.5"
            />
            <path
              d={describeArc(center, center, radius, 0, 135)}
              className="gaugeZoneTrack up"
              strokeWidth="4.5"
            />
            <path
              d={activeFillPath}
              className="gaugeActiveFill"
              strokeWidth="5"
              stroke="url(#volatilityActiveGrad)"
            />

            <line
              x1={center}
              y1={center - radius - 4}
              x2={center}
              y2={center - radius + 3}
              className="gaugeStrikeAnchor"
              strokeWidth="1.5"
            />

            {[-135, -90, -45, 0, 45, 90, 135].map((angle) => {
              const innerPoint = polarToCartesian(center, center, radius - 2, angle);
              const outerPoint = polarToCartesian(center, center, radius + 2, angle);
              return (
                <line
                  key={angle}
                  x1={innerPoint.x}
                  y1={innerPoint.y}
                  x2={outerPoint.x}
                  y2={outerPoint.y}
                  className="gaugeDialTick"
                  strokeWidth="0.8"
                />
              );
            })}

            <g
              transform={`rotate(${angleDegrees} ${center} ${center})`}
              style={{ transition: 'transform 0.5s cubic-bezier(0.25, 1, 0.5, 1)' }}
            >
              <line
                x1={center}
                y1={center}
                x2={center}
                y2={center - radius + 2}
                className={`gaugeNeedle ${activeZoneClass}`}
                strokeWidth="2"
              />
              <polygon
                points={`${center - 2.5},${center - radius + 3} ${center + 2.5},${center - radius + 3} ${center},${center - radius}`}
                className={`gaugeNeedleTip ${activeZoneClass}`}
              />
            </g>

            <circle cx={center} cy={center} r="4.5" className="gaugeHubOuter" />
            <circle cx={center} cy={center} r="2" className={`gaugeHubInner ${activeZoneClass}`} />
          </svg>

          <div className="gaugeZoneLabels">
            <span className="gaugeSideLabel LOW">LOW</span>
            <div className="gaugeDigitalReadout">
              <span className={`gaugeDiffValue ${activeZoneClass}`}>{formatNumber(rangeBps120s, 2)} bps</span>
              <span className="gaugeDiffBps">stdev ${formatNumber(volatility120s, 2)} / pos {rangePositionLabel}</span>
            </div>
            <span className="gaugeSideLabel HIGH">HIGH</span>
          </div>
        </div>

        <div className="gaugeHeader">
          <span>center two-sided {formatNumber(centerMinBiExcursionBps120s, 2)}bps</span>
          <span>balance {formatNumber(centerExcursionBalance120s, 2)}</span>
        </div>
      </div>
    </div>
  );
};
