export type OutcomeLabel = 'YES' | 'NO' | 'UNKNOWN';
export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export function shortenTokenId(id: string): string {
  if (!id) return '-';
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}...${id.slice(-8)}`;
}

export function outcomeLabel(label: OutcomeLabel): string {
  if (label === 'UNKNOWN') return 'UNKNOWN';
  return label === 'YES' ? 'UP' : 'DOWN';
}

export function outcomeTone(label: OutcomeLabel): Exclude<Tone, 'warn'> {
  if (label === 'UNKNOWN') return 'neutral';
  return label === 'YES' ? 'good' : 'bad';
}

export function formatEtTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'n/a';
  return `${date.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })} ET`;
}
