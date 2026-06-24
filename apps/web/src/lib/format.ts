import type { ExecutionMode } from '../../../../packages/shared/src';

export function modeLabel(mode: ExecutionMode): string {
  return mode === 'live' ? 'live trading' : 'monitor only';
}

export function formatMoney(value: number): string {
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
}

export function formatNumber(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }) : 'n/a';
}

export function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const minutes = Math.floor(abs / 60);
  const seconds = Math.floor(abs % 60);
  return minutes > 0 ? `${sign}${minutes}m ${seconds}s` : `${sign}${seconds}s`;
}
