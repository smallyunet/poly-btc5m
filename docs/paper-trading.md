# Paper trading runtime

Paper is the sole execution model on `main`. Public market data drives strategy
evaluation and deterministic simulated fills; no wallet credential is accepted
or used.

## Experiment identity

Keep `PAPER_RUN_ID` stable only while code, strategy parameters, and fill-model
assumptions are stable. The ledger rejects reopening an existing run ID with a
different config hash or fill-model version. Start a new run ID for every
material experiment change.

## Retention contract

`PaperLedger` stores runs and append-only events in SQLite WAL mode. Orders,
fills, settlements, strategy checks, snapshots, and runtime logs are retained
without the dashboard's record cap. Use cursor pagination on `/api/paper/events`
instead of loading the complete history into memory.

The JSON runtime file remains a bounded recovery/read model. It is not the
research system of record.

## Fill assumptions

- Dual: full fill at `min(limit, bestAsk)` after an eligible websocket ask
  touches the simulated GTC limit.
- Tail: immediate full fill at evaluated VWAP after all Tail gates pass.
- No queue priority, partial fill, latency, rejection, or adverse-selection
  model is currently applied.
- Hedge/profit-exit/loss-exit planners remain visible for analysis, but there is
  no execution path for them in the Paper runtime.

These limitations must be considered during edge analysis.

## Backup

For a live service, use SQLite online backup or stop the API before copying
`paper.sqlite`, `paper.sqlite-wal`, and `paper.sqlite-shm` together. Periodically
verify that a copied database opens and that event counts match `/api/paper/stats`.
