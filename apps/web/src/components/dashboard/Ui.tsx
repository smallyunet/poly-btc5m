import React from 'react';

import type { Tone } from '../../lib/dashboardFormat';

export function Shell({ children }: { children: React.ReactNode }) {
  return <div className="appShell">{children}</div>;
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
