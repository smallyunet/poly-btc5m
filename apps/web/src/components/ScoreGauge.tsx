import React from 'react';

interface ScoreGaugeProps {
  score: number;
  threshold?: number;
}

export const ScoreGauge: React.FC<ScoreGaugeProps> = ({ score, threshold = 70 }) => {
  // SVG Circle parameters
  const radius = 36;
  const strokeWidth = 6;
  const center = 50;
  const circumference = 2 * Math.PI * radius;
  
  // Clamp score between 0 and 100
  const clampedScore = Math.max(0, Math.min(100, score));
  const strokeDashoffset = circumference - (clampedScore / 100) * circumference;
  
  // Determine tone and labels based on score
  const isPassed = score >= threshold;
  let scoreToneColor = 'var(--color-primary)';
  let glowColor = 'rgba(37, 99, 235, 0.2)';
  let statusText = 'LOW CHOP';

  if (score >= 80) {
    scoreToneColor = 'var(--color-success)';
    glowColor = 'rgba(16, 185, 129, 0.25)';
    statusText = 'CHOP HIGH';
  } else if (score >= 70) {
    scoreToneColor = 'var(--color-warning)';
    glowColor = 'rgba(217, 119, 6, 0.25)';
    statusText = 'CHOP ACTIVE';
  } else {
    scoreToneColor = 'var(--color-danger)';
    glowColor = 'rgba(225, 29, 72, 0.25)';
    statusText = 'TREND REGIME';
  }

  // Calculate coordinates for the threshold marker tick
  // The circle starts at -90 degrees (top). So angle = -90 + (threshold / 100) * 360
  const thresholdAngleRad = ((-90 + (threshold / 100) * 360) * Math.PI) / 180;
  const tickX = center + radius * Math.cos(thresholdAngleRad);
  const tickY = center + radius * Math.sin(thresholdAngleRad);

  return (
    <div className="scoreGaugeWrapper">
      <div className="scoreGaugeContainer" style={{ filter: `drop-shadow(0 0 8px ${glowColor})` }}>
        <svg viewBox="0 0 100 100" className="scoreGaugeSvg">
          {/* Gradient definitions */}
          <defs>
            <linearGradient id="scoreGaugeGrad" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="var(--color-danger)" />
              <stop offset="60%" stopColor="var(--color-warning)" />
              <stop offset="100%" stopColor="var(--color-success)" />
            </linearGradient>
            <linearGradient id="scoreGaugeGradBlue" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="var(--color-primary)" />
              <stop offset="100%" stopColor="var(--color-success)" />
            </linearGradient>
          </defs>
          
          {/* Background track */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            className="scoreGaugeTrack"
            strokeWidth={strokeWidth}
          />
          
          {/* Active progress stroke */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            className="scoreGaugeFill"
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            stroke={isPassed ? "url(#scoreGaugeGrad)" : "url(#scoreGaugeGrad)"}
            transform={`rotate(-90 ${center} ${center})`}
          />
          
          <circle
            cx={tickX}
            cy={tickY}
            r="1.8"
            className="scoreGaugeThresholdTick"
          >
            <title>Threshold: {threshold}</title>
          </circle>
        </svg>
        
        {/* Digital display overlay in the center */}
        <div className="scoreGaugeOverlay">
          <span className="scoreGaugeNumber">{score.toFixed(1)}</span>
          <span className="scoreGaugeLabel" style={{ color: scoreToneColor }}>
            {statusText}
          </span>
        </div>
      </div>
      
      <div className="scoreGaugeLegend">
        <span className={`scoreThresholdText ${isPassed ? 'passed' : 'blocked'}`}>
          {isPassed ? '✓' : '✗'} Threshold ({threshold}) {isPassed ? 'Passed' : 'Blocked'}
        </span>
      </div>
    </div>
  );
};
