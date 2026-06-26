import React from 'react';

interface PriceStrikeGaugeProps {
  btcPrice: number;
  strikePrice: number;
  priceDiff: number;
  strikeLabel: string;
  terminalGaugeStatus: string;
  gaugePct: number;
}

export const PriceStrikeGauge: React.FC<PriceStrikeGaugeProps> = ({
  btcPrice,
  strikePrice,
  priceDiff,
  strikeLabel,
  terminalGaugeStatus,
  gaugePct,
}) => {
  // Helper to convert polar coordinates to Cartesian
  const polarToCartesian = (centerX: number, centerY: number, radius: number, angleInDegrees: number) => {
    const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
    return {
      x: centerX + radius * Math.cos(angleInRadians),
      y: centerY + radius * Math.sin(angleInRadians),
    };
  };

  // Helper to describe an SVG arc path
  const describeArc = (x: number, y: number, radius: number, startAngle: number, endAngle: number) => {
    const start = polarToCartesian(x, y, radius, endAngle);
    const end = polarToCartesian(x, y, radius, startAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
    return [
      'M', start.x, start.y,
      'A', radius, radius, 0, largeArcFlag, 0, end.x, end.y
    ].join(' ');
  };

  // Gauge configurations
  const center = 50;
  const radius = 38;
  
  // Map gaugePct (5 to 95) to angle (-135 to 135 degrees relative to top)
  const pctRatio = (gaugePct - 50) / 50; // Ranges between -0.9 and +0.9 (since gaugePct is 5 to 95)
  const angleDegrees = pctRatio * 135;
  const isBtcAboveStrike = priceDiff >= 0;

  // Active fill path
  let activeFillPath = '';
  if (priceDiff !== 0) {
    if (isBtcAboveStrike) {
      // Arc from 0 (top) to angleDegrees (right)
      activeFillPath = describeArc(center, center, radius, 0, Math.max(1, angleDegrees));
    } else {
      // Arc from angleDegrees (left) to 0 (top)
      activeFillPath = describeArc(center, center, radius, Math.min(-1, angleDegrees), 0);
    }
  }

  const activeZoneClass = isBtcAboveStrike ? 'above' : 'below';
  const priceDiffText = `${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(2)} USD`;
  const priceDiffBps = `${(priceDiff / strikePrice * 10000).toFixed(1)} bps`;

  return (
    <div className="priceStrikeGaugeWrapper">
      <div className="gaugeCockpitContainer">
        
        {/* Telemetry Header */}
        <div className="gaugeCockpitHeader">
          <div className="gaugeTelemetryItem">
            <span>{strikeLabel}</span>
            <strong>${strikePrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
          </div>
          <div className="gaugeStatusBadge">
            <span className={`pulseDot ${activeZoneClass}`}></span>
            <span className="statusText">{terminalGaugeStatus}</span>
          </div>
          <div className="gaugeTelemetryItem text-right">
            <span>BTC Price</span>
            <strong className={activeZoneClass}>${btcPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
          </div>
        </div>

        {/* SVG Speedometer Dial */}
        <div className="gaugeDialFrame">
          <svg viewBox="0 0 100 75" className="gaugeDialSvg">
            <defs>
              {/* Down Zone gradient */}
              <linearGradient id="downZoneGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(225, 29, 72, 0.4)" />
                <stop offset="100%" stopColor="rgba(37, 99, 235, 0.05)" />
              </linearGradient>
              {/* Up Zone gradient */}
              <linearGradient id="upZoneGrad" x1="100%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="rgba(16, 185, 129, 0.4)" />
                <stop offset="100%" stopColor="rgba(37, 99, 235, 0.05)" />
              </linearGradient>
              {/* Active Down Fill */}
              <linearGradient id="activeDownGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="var(--color-danger)" />
                <stop offset="100%" stopColor="#8b5cf6" />
              </linearGradient>
              {/* Active Up Fill */}
              <linearGradient id="activeUpGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="var(--color-primary)" />
                <stop offset="100%" stopColor="var(--color-success)" />
              </linearGradient>
            </defs>

            {/* Down Zone background track */}
            <path
              d={describeArc(center, center, radius, -135, 0)}
              className="gaugeZoneTrack down"
              strokeWidth="4.5"
            />

            {/* Up Zone background track */}
            <path
              d={describeArc(center, center, radius, 0, 135)}
              className="gaugeZoneTrack up"
              strokeWidth="4.5"
            />

            {/* Active zone fill path */}
            {activeFillPath && (
              <path
                d={activeFillPath}
                className={`gaugeActiveFill ${activeZoneClass}`}
                strokeWidth="5"
                stroke={isBtcAboveStrike ? 'url(#activeUpGrad)' : 'url(#activeDownGrad)'}
              />
            )}

            {/* Center Strike Anchor (0 degree tick) */}
            <line
              x1={center}
              y1={center - radius - 4}
              x2={center}
              y2={center - radius + 3}
              className="gaugeStrikeAnchor"
              strokeWidth="1.5"
            />

            {/* Outer dial ticks for decoration */}
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

            {/* Dial Needle */}
            <g
              transform={`rotate(${angleDegrees} ${center} ${center})`}
              style={{ transition: 'transform 0.5s cubic-bezier(0.25, 1, 0.5, 1)' }}
            >
              {/* Pointer Needle Line */}
              <line
                x1={center}
                y1={center}
                x2={center}
                y2={center - radius + 2}
                className={`gaugeNeedle ${activeZoneClass}`}
                strokeWidth="2"
              />
              {/* Pointer Arrow Tip */}
              <polygon
                points={`${center - 2.5},${center - radius + 3} ${center + 2.5},${center - radius + 3} ${center},${center - radius}`}
                className={`gaugeNeedleTip ${activeZoneClass}`}
              />
            </g>

            {/* Center Hub */}
            <circle cx={center} cy={center} r="4.5" className="gaugeHubOuter" />
            <circle cx={center} cy={center} r="2" className={`gaugeHubInner ${activeZoneClass}`} />
          </svg>

          {/* Value Overlays on Dial */}
          <div className="gaugeZoneLabels">
            <span className="gaugeSideLabel DOWN">DOWN ZONE</span>
            <div className="gaugeDigitalReadout">
              <span className={`gaugeDiffValue ${activeZoneClass}`}>{priceDiffText}</span>
              <span className="gaugeDiffBps">{priceDiffBps}</span>
            </div>
            <span className="gaugeSideLabel UP">UP ZONE</span>
          </div>
        </div>
      </div>
    </div>
  );
};
