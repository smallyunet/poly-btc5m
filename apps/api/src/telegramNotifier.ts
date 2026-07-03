import type { DashboardState, FillRecord, OrderRecord, SettlementRecord, StrategyCheck } from '../../../packages/shared/src';
import type { PolymarketAdapter } from '../../../packages/polymarket/src';
import type { AppConfig } from './config';
import type { InMemoryStore } from './store';

type TelegramNotifierOptions = {
  appConfig: AppConfig;
  store: InMemoryStore;
  adapter: PolymarketAdapter;
};

type PendingNotification =
  | { kind: 'round-summary'; key: string; text: string }
  | { kind: 'idle-summary'; text: string };

type AccountSummary = {
  balance?: number;
  allowance?: number | null;
  error?: string;
};

export class TelegramNotifier {
  private readonly startedAtMs = Date.now();
  private bootstrapped = false;

  constructor(private readonly options: TelegramNotifierOptions) {}

  async notifyAfterTick(state: DashboardState): Promise<void> {
    if (!this.enabled()) return;
    this.bootstrapExistingRoundSummaries(state);
    const pending = this.pendingNotifications(state);
    if (!pending.length) return;

    const account = await this.loadAccountSummary();
    for (const notification of pending) {
      const text = `${notification.text}\n${formatAccountSummary(account)}`;
      const sent = await this.sendMessage(text);
      if (!sent) continue;
      if (notification.kind === 'round-summary') {
        this.options.store.markTelegramRoundSummaryNotified(notification.key);
      } else {
        this.options.store.markTelegramIdleSummaryNotified();
      }
    }
  }

  private enabled(): boolean {
    const { telegramNotifyEnabled, telegramBotToken, telegramChatId } = this.options.appConfig;
    return Boolean(telegramNotifyEnabled && telegramBotToken?.trim() && telegramChatId?.trim());
  }

  private pendingNotifications(state: DashboardState): PendingNotification[] {
    const pending: PendingNotification[] = [];
    const notificationState = this.options.store.getTelegramNotificationState();
    const notifiedRoundKeys = new Set(notificationState.notifiedRoundSummaryKeys);
    const roundSummary = this.nextRoundSummary(state, notifiedRoundKeys);
    if (roundSummary) pending.push(roundSummary);
    const idleSummary = this.nextIdleSummary(state, notificationState.lastIdleSummaryAt);
    if (idleSummary) pending.push(idleSummary);
    return pending;
  }

  private nextRoundSummary(state: DashboardState, notifiedRoundKeys: Set<string>): PendingNotification | null {
    const settlements = [...state.settlements].sort((a, b) => toTime(b.resolvedAt) - toTime(a.resolvedAt));
    for (const settlement of settlements) {
      const key = `${settlement.roundId}:${settlement.status}`;
      if (notifiedRoundKeys.has(key)) continue;
      if (roundEndMs(settlement.roundId) < this.startedAtMs) {
        this.options.store.markTelegramRoundSummaryNotified(key);
        continue;
      }
      const orders = state.orders.filter((order) => order.roundId === settlement.roundId);
      if (this.options.appConfig.telegramRoundSummaryOnOrderOnly && !orders.length) continue;
      const fills = state.fills.filter((fill) => fill.roundId === settlement.roundId);
      return {
        kind: 'round-summary',
        key,
        text: buildRoundSummary(state, settlement, orders, fills),
      };
    }
    return null;
  }

  private bootstrapExistingRoundSummaries(state: DashboardState): void {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    const notifiedRoundKeys = new Set(this.options.store.getTelegramNotificationState().notifiedRoundSummaryKeys);
    for (const settlement of state.settlements) {
      const key = `${settlement.roundId}:${settlement.status}`;
      if (notifiedRoundKeys.has(key)) continue;
      if (roundEndMs(settlement.roundId) <= this.startedAtMs) {
        this.options.store.markTelegramRoundSummaryNotified(key);
      }
    }
  }

  private nextIdleSummary(state: DashboardState, lastIdleSummaryAt: string | undefined): PendingNotification | null {
    const nowMs = Date.now();
    const intervalMs = this.options.appConfig.telegramIdleSummaryIntervalMs;
    const latestOrderAt = latestTime(state.orders.map((order) => order.createdAt));
    const referenceMs = latestOrderAt || toTime(state.runtime.startedAt);
    if (!referenceMs || nowMs - referenceMs < intervalMs) return null;
    const lastIdleMs = lastIdleSummaryAt ? toTime(lastIdleSummaryAt) : 0;
    if (lastIdleMs && nowMs - lastIdleMs < intervalMs) return null;
    return {
      kind: 'idle-summary',
      text: buildIdleSummary(state, referenceMs),
    };
  }

  private async loadAccountSummary(): Promise<AccountSummary> {
    try {
      const account = await this.options.adapter.getCollateralBalanceAllowance();
      return account;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.store.recordRuntimeLog({
        level: 'warn',
        source: 'telegram',
        message: `Telegram account summary balance read failed: ${message}`,
      });
      return { error: message };
    }
  }

  private async sendMessage(text: string): Promise<boolean> {
    const token = this.options.appConfig.telegramBotToken?.trim();
    const chatId = this.options.appConfig.telegramChatId?.trim();
    if (!token || !chatId) return false;
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: truncateTelegramMessage(text),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Telegram sendMessage returned ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
      }
      this.options.store.recordRuntimeLog({ level: 'info', source: 'telegram', message: 'Telegram notification sent.' });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.store.recordRuntimeLog({ level: 'warn', source: 'telegram', message: `Telegram notification failed: ${message}` });
      return false;
    }
  }
}

function buildRoundSummary(state: DashboardState, settlement: SettlementRecord, orders: OrderRecord[], fills: FillRecord[]): string {
  const title = settlement.marketTitle || settlement.roundId;
  const statusLabel = settlement.status === 'settled' ? 'settled' : 'estimated';
  const filledOrders = orders.filter((order) => order.status === 'filled' || order.status === 'partially_filled').length;
  const failedOrders = orders.filter((order) => order.status === 'failed').length;
  const cancelledOrders = orders.filter((order) => order.status === 'cancelled').length;
  return formatTelegramSummary('BTC5M Round Summary', [
    section('Market', [
      ['Round', title],
      ['Status', `${statusLabel}${settlement.winningLabel ? `, winner ${settlement.winningLabel}` : ''}`],
    ]),
    section('Orders', [
      ['Orders', `${orders.length} total, ${filledOrders} filled/partial, ${cancelledOrders} cancelled, ${failedOrders} failed`],
      ['Fills', `${fillSideSummary(fills, 'YES')} | ${fillSideSummary(fills, 'NO')}`],
      ['Cost', `${formatMoney(settlement.totalCost)} | Payout ${formatMoney(settlement.payout)}`],
    ]),
    section('PnL', [
      ['Round', formatPnlStatus(settlement.pnl)],
      ['Settled', formatPnlStatus(totalSettledPnl(state))],
    ]),
    section('System', [
      ['Runtime', `${state.runtime.executionMode}, ${state.runtime.status}`],
    ]),
  ]);
}

function buildIdleSummary(state: DashboardState, referenceMs: number): string {
  const entryCheck = state.strategyChecks.find((check) => check.strategy === 'BTC5M_DUAL_45' || check.strategy === 'BTC5M_NEXT_ROUND_50_49_STOP_ON_SINGLE');
  const blockers = topBlockers(entryCheck);
  const openOrders = state.orders.filter((order) => order.status === 'posted' || order.status === 'partially_filled' || (state.runtime.executionMode === 'monitor' && order.status === 'local')).length;
  return formatTelegramSummary('BTC5M Idle Summary', [
    section('Idle', [
      ['No order', formatDuration(Date.now() - referenceMs)],
      ['Round', state.latestSnapshot.round.title || state.latestSnapshot.round.id],
      ['Phase', `${state.latestSnapshot.round.phase}, ${state.latestSnapshot.round.secondsToStart > 0 ? `${Math.round(state.latestSnapshot.round.secondsToStart)}s to start` : `${Math.round(state.latestSnapshot.round.secondsToEnd)}s to end`}`],
    ]),
    section('Market', [
      ['Regime', `${state.latestSnapshot.regime}, chop ${formatNumber(state.latestSnapshot.features.chopScore, 1)}`],
      ['Open', `${openOrders} orders | ${state.latestSnapshot.positions.length} positions`],
      ['Cooldown', state.runtime.entryCooldownUntil ? `${state.runtime.entryCooldownReason || 'active'} until ${state.runtime.entryCooldownUntil}` : 'none'],
    ]),
    section('PnL', [
      ['Settled', formatPnlStatus(totalSettledPnl(state))],
    ]),
    section('System', [
      ['Runtime', `${state.runtime.executionMode}, ${state.runtime.status}`],
    ]),
    blockersSection(blockers),
  ]);
}

function fillSideSummary(fills: FillRecord[], label: 'YES' | 'NO'): string {
  const sideFills = fills.filter((fill) => fill.label === label);
  const buyShares = sum(sideFills.filter((fill) => fill.side === 'BUY').map((fill) => fill.size));
  const sellShares = sum(sideFills.filter((fill) => fill.side === 'SELL').map((fill) => fill.size));
  const buyCost = sum(sideFills.filter((fill) => fill.side === 'BUY').map((fill) => fill.price * fill.size));
  const avgBuy = buyShares > 0 ? buyCost / buyShares : null;
  return `${label} buy ${formatNumber(buyShares, 2)}${avgBuy == null ? '' : ` @ ${formatNumber(avgBuy, 3)}`}${sellShares > 0 ? `, sell ${formatNumber(sellShares, 2)}` : ''}`;
}

function formatAccountSummary(account: AccountSummary): string {
  return [
    '<b>Account</b>',
    formatRow('Balance', account.error ? 'unavailable' : formatMoney(account.balance ?? 0)),
  ].join('\n');
}

function topBlockers(check: StrategyCheck | undefined): string[] {
  if (!check) return [];
  if (check.blockers.length) return check.blockers.slice(0, 4);
  return check.conditions
    .filter((condition) => !condition.passed)
    .slice(0, 4)
    .map((condition) => condition.label);
}

function totalSettledPnl(state: DashboardState): number {
  return sum(state.settlements.filter((settlement) => settlement.status === 'settled').map((settlement) => settlement.pnl));
}

function latestTime(values: string[]): number {
  return Math.max(0, ...values.map(toTime));
}

function toTime(value: string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function roundEndMs(roundId: string): number {
  const match = roundId.match(/btc-updown-5m-(\d+)$/);
  const startSeconds = Number(match?.[1]);
  if (!Number.isFinite(startSeconds) || startSeconds <= 0) return 0;
  return startSeconds * 1000 + 5 * 60_000;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function formatMoney(value: number): string {
  return `$${formatNumber(value, 2)}`;
}

function formatSignedMoney(value: number): string {
  return `${value >= 0 ? '+' : '-'}$${formatNumber(Math.abs(value), 2)}`;
}

function formatPnlStatus(value: number): string {
  if (value > 0) return `🟢 PROFIT ${formatSignedMoney(value)}`;
  if (value < 0) return `🔴 LOSS ${formatSignedMoney(value)}`;
  return `⚪ FLAT ${formatSignedMoney(value)}`;
}

function formatNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

type SummarySection = {
  heading: string;
  rows?: [string, string][];
  lines?: string[];
};

function formatTelegramSummary(title: string, sections: SummarySection[]): string {
  return [
    `<b>${escapeHtml(title)}</b>`,
    ...sections.filter((item) => item.rows?.length || item.lines?.length).map(formatSection),
  ].join('\n');
}

function section(heading: string, rows: [string, string][]): SummarySection {
  return { heading, rows };
}

function blockersSection(blockers: string[]): SummarySection {
  return {
    heading: 'Top blockers',
    lines: blockers.length ? blockers.map((blocker) => `- ${blocker}`) : ['none'],
  };
}

function formatSection(section: SummarySection): string {
  const lines = section.rows ? section.rows.map(([label, value]) => formatRow(label, value)) : (section.lines || []).map(escapeHtml);
  return [
    `<b>${escapeHtml(section.heading)}</b>`,
    ...lines,
  ].join('\n');
}

function formatRow(label: string, value: string): string {
  return `<b>${escapeHtml(label)}</b>: ${escapeHtml(value)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncateTelegramMessage(text: string): string {
  const maxLength = 3900;
  if (text.length <= maxLength) return text;
  const plainText = text.replace(/<\/?[^>]+>/g, '');
  const truncated = `${plainText.slice(0, maxLength - 80)}\n... truncated`;
  return `<b>BTC5M Notification</b>\n<pre>${escapeHtml(truncated)}</pre>`;
}
