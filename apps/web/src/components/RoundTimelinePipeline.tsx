import React from 'react';

interface RoundTimelinePipelineProps {
  phase: string;
  timelineDetail: string;
  progressPct: number;
  progressColorClass: string;
}

interface PipelineStep {
  key: string;
  label: string;
  subLabel: string;
}

export const RoundTimelinePipeline: React.FC<RoundTimelinePipelineProps> = ({
  phase,
  timelineDetail,
  progressPct,
  progressColorClass,
}) => {
  // Map phase to step index
  const normalizedPhase = phase.toLowerCase().trim();
  
  const steps: PipelineStep[] = [
    { key: 'observing', label: 'OBSERVING', subLabel: 'Pre-round analysis' },
    { key: 'decision', label: 'DECISION', subLabel: 'T-30s entry gate' },
    { key: 'posting', label: 'POSTING', subLabel: 'Order execution' },
    { key: 'running', label: 'RUNNING', subLabel: '5m contract life' },
    { key: 'settled', label: 'SETTLED', subLabel: 'Round conclusion' },
  ];

  // Find active step index
  let activeIndex = steps.findIndex(s => s.key === normalizedPhase);
  if (activeIndex === -1) {
    // Fallbacks for different states
    if (normalizedPhase.includes('observe') || normalizedPhase.includes('wait')) {
      activeIndex = 0;
    } else if (normalizedPhase.includes('decide') || normalizedPhase.includes('window')) {
      activeIndex = 1;
    } else if (normalizedPhase.includes('post') || normalizedPhase.includes('entry')) {
      activeIndex = 2;
    } else if (normalizedPhase.includes('run') || normalizedPhase.includes('active')) {
      activeIndex = 3;
    } else if (normalizedPhase.includes('settle') || normalizedPhase.includes('close') || normalizedPhase.includes('resolved')) {
      activeIndex = 4;
    } else {
      activeIndex = 0;
    }
  }

  // Calculate overall timeline progress (continuous interpolation)
  // 5 nodes mean 4 connecting gaps. Each gap represents 25% of total width.
  const overallProgress = Math.min(100, Math.max(0, ((activeIndex + (progressPct / 100)) / 4) * 100));

  return (
    <div className="timelinePipelineWrapper">
      <div className="pipelineContainer">
        
        {/* Continuous Progress Line */}
        <div className="pipelineProgressLine">
          <div className="pipelineLineTrack"></div>
          <div 
            className={`pipelineLineFill ${progressColorClass}`} 
            style={{ width: `${overallProgress}%` }}
          ></div>
        </div>

        {/* Pipeline Nodes */}
        <div className="pipelineNodes">
          {steps.map((step, idx) => {
            const isCompleted = idx < activeIndex;
            const isActive = idx === activeIndex;
            const isUpcoming = idx > activeIndex;
            
            let nodeStateClass = 'upcoming';
            if (isCompleted) nodeStateClass = 'completed';
            if (isActive) nodeStateClass = 'active';

            return (
              <div key={step.key} className={`pipelineNodeItem ${nodeStateClass}`}>
                
                {/* Node Circle */}
                <div className="pipelineNodeCircle">
                  {isCompleted ? (
                    <span className="nodeIcon check">✓</span>
                  ) : isActive ? (
                    <span className="nodeIcon dot"></span>
                  ) : (
                    <span className="nodeIcon index">{idx + 1}</span>
                  )}
                  
                  {/* Pulsing ring around active node */}
                  {isActive && (
                    <>
                      <span className={`nodePulseRing ${progressColorClass}`}></span>
                      <span className={`nodePulseRingOuter ${progressColorClass}`}></span>
                    </>
                  )}
                </div>

                {/* Node Labels */}
                <div className="pipelineNodeLabels">
                  <span className="nodeLabel">{step.label}</span>
                  <span className="nodeSubLabel">{step.subLabel}</span>
                  
                  {/* Countdown detail if active */}
                  {isActive && (
                    <span className={`nodeTelemetry ${progressColorClass}`}>
                      {timelineDetail}
                    </span>
                  )}
                </div>

              </div>
            );
          })}
        </div>

      </div>
    </div>
  );
};
