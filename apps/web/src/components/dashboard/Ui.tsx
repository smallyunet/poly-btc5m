import React from 'react';

import type { Tone } from '../../lib/dashboardFormat';

export type RuntimeModeItem = {
  label: string;
  value: string;
  detail: string;
  tone: Tone;
};

export function Shell({ children }: { children: React.ReactNode }) {
  return <div className="appShell">{children}</div>;
}

export function RuntimeModeStrip({ items }: { items: RuntimeModeItem[] }) {
  return (
    <section className="runtimeModeStrip" aria-label="Runtime configuration">
      {items.map((item) => (
        <div key={item.label} className={`runtimeModeItem ${item.tone}`} title={item.detail}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          <em>{item.detail}</em>
        </div>
      ))}
    </section>
  );
}

export function Digest({
  icon,
  label,
  value,
  detail,
  tone,
  priority = 'secondary',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: Tone;
  priority?: 'primary' | 'secondary';
}) {
  return (
    <div className={`digestCard ${tone} ${priority}`}>
      <div className="digestHeader">
        {icon}
        <span>{label}</span>
        {(tone === 'good' || tone === 'warn' || tone === 'bad') && (
          <span className={`liveDot ${tone}`} style={{ marginLeft: 'auto' }}></span>
        )}
      </div>
      <strong className="digestValue">{value}</strong>
      <em className="digestDetail">{detail}</em>
    </div>
  );
}

export function DecisionMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: Tone;
}) {
  return (
    <div className={`decisionMetric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </div>
  );
}

export function PageIntro({
  kicker,
  title,
  summary,
  meta,
  tone = 'neutral',
  children,
}: {
  kicker: string;
  title: string;
  summary: string;
  meta?: React.ReactNode;
  tone?: Tone;
  children?: React.ReactNode;
}) {
  return (
    <section className={`pageIntro ${tone}`} aria-label={title}>
      <div className="pageIntroMain">
        <span className="sectionKicker">{kicker}</span>
        <h2>{title}</h2>
        <p>{summary}</p>
      </div>
      {meta && <div className="pageIntroMeta">{meta}</div>}
      {children && <div className="pageIntroMetrics">{children}</div>}
    </section>
  );
}

export function ViewHeader({
  kicker,
  title,
  summary,
  meta,
}: {
  kicker: string;
  title: string;
  summary: string;
  meta?: React.ReactNode;
}) {
  return (
    <div className="viewHeader">
      <div>
        <span className="sectionKicker">{kicker}</span>
        <h3>{title}</h3>
        <p>{summary}</p>
      </div>
      {meta && <div className="viewHeaderMeta">{meta}</div>}
    </div>
  );
}

export function DataTable({ headers, children, className = '' }: { headers: string[]; children: React.ReactNode; className?: string }) {
  return (
    <div className="tableWrap">
      <table className={className}>
        <thead>
          <tr>
            {headers.map((header) => <th key={header}>{header}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function PaginationControls({
  page,
  totalPages,
  totalRows,
  pageSize,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  totalRows: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  if (totalRows <= pageSize) return null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(totalRows, page * pageSize);
  return (
    <div className="paginationBar">
      <span className="paginationSummary">
        Showing {start}-{end} of {totalRows}
      </span>
      <div className="paginationControls">
        <button type="button" onClick={() => onPageChange(1)} disabled={page === 1}>First</button>
        <button type="button" onClick={() => onPageChange(page - 1)} disabled={page === 1}>Previous</button>
        <span className="paginationPage">Page {page} / {totalPages}</span>
        <button type="button" onClick={() => onPageChange(page + 1)} disabled={page === totalPages}>Next</button>
        <button type="button" onClick={() => onPageChange(totalPages)} disabled={page === totalPages}>Last</button>
      </div>
    </div>
  );
}

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
