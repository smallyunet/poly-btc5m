import { z } from 'zod';

export const executionModeSchema = z.enum(['monitor', 'live']);

export const btcRoundConfigSchema = z.object({
  eventSlug: z.string().min(1),
  title: z.string().optional(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  strike: z.number().positive(),
  yesTokenId: z.string(),
  noTokenId: z.string(),
  sourceUrl: z.string().optional(),
  imageUrl: z.string().optional(),
});

export const btcMarketConfigSchema = z.object({
  seriesSlug: z.string().min(1),
  title: z.string().min(1),
  roundDurationSeconds: z.number().int().positive().default(300),
  decisionLeadSeconds: z.number().int().positive().default(30),
  avoidExpirySeconds: z.number().int().nonnegative().default(30),
  strike: z.number().positive().optional(),
  yesTokenId: z.string().optional(),
  noTokenId: z.string().optional(),
  staticRound: btcRoundConfigSchema.optional(),
});
