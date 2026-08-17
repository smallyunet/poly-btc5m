export function roundSlugCandidates(asset, interval, startSec) {
  const slugs = [`${asset}-updown-${interval}-${startSec}`];
  if (interval !== '1h') return slugs;
  const assetName = {
    btc: 'bitcoin',
    eth: 'ethereum',
    sol: 'solana',
    doge: 'dogecoin',
    xrp: 'xrp',
    hype: 'hyperliquid',
  }[asset];
  if (!assetName) return slugs;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    hour12: true,
  }).formatToParts(new Date(startSec * 1_000));
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  const month = part('month').toLowerCase();
  const day = part('day');
  const year = part('year');
  const hour = part('hour').toLowerCase();
  const dayPeriod = part('dayPeriod').toLowerCase();
  if (month && day && year && hour && dayPeriod) {
    slugs.push(`${assetName}-up-or-down-${month}-${day}-${year}-${hour}${dayPeriod}-et`);
  }
  return slugs;
}
