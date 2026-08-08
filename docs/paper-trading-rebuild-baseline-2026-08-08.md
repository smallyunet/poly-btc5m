# Paper Trading Rebuild Baseline — 2026-08-08

This document freezes the code and retained-data baseline before the Paper
Trading rebuild. It contains no credentials and does not make the archived
research data part of Git.

## Code baseline

- Baseline commit: `9bcdde3156c99523f3a1b19a68c7816c89f4f4b9`
- Archive branch: `archive/research-v1-shutdown-2026-07-16`
- Annotated tag: `research-v1-final`
- Development branch after archival: `main`
- Remote publication: not performed as part of this baseline

Both archive refs were created locally at the baseline commit without checking
out the archive branch. The working branch remained `main`.

## Server baseline

- Host alias: `a`
- Application path: `/root/apps/poly-btc5m`
- Compose file: `docker-compose.prod.yml`
- Compose state: no containers listed by `docker compose ... ps -a`
- Filesystem: 75 GiB total, 20 GiB used, 53 GiB available (27% used)
- Runtime data: 7.4 MiB
- Research data: 448 MiB
- Latest retained write: 2026-07-16 01:55:10 UTC

The runtime state is schema version 2, saved at
`2026-07-16T01:55:10.568Z`, with the following capped arrays:

| Record family | Retained rows |
|---|---:|
| Intents | 1,000 |
| Orders | 1,000 |
| Fills | 1,000 |
| Settlements | 1,000 |
| Single-fill cooldown events | 39 |
| Tail cooldown events | 1 |

## Research data inventory

| Dataset | File | Rows |
|---|---|---:|
| 5m touch | `round-results.ndjson` | 277,431 |
| 5m touch | `rounds.ndjson` | 27,249 |
| 5m touch | `touches.ndjson` | 155,945 |
| 5m Tail | `rounds.ndjson` | 16,686 |
| 5m Tail | `samples.ndjson` | 75,126 |
| 5m Tail | `tail-results.ndjson` | 136,574 |
| 15m touch | `round-results.ndjson` | 69,048 |
| 15m touch | `rounds.ndjson` | 6,263 |
| 15m touch | `touches.ndjson` | 81,333 |
| 15m Tail | `rounds.ndjson` | 363 |
| 15m Tail | `samples.ndjson` | 2,404 |
| 15m Tail | `tail-results.ndjson` | 2,373 |

The retained summaries report:

| Dataset | All-time rounds or rows |
|---|---:|
| 5m touch completed rounds | 13,193 |
| 5m Tail completed rows | 74,100 |
| 5m Tail sampled rounds | 10,631 |
| 15m touch completed rounds | 3,288 |
| 15m Tail completed rows | 2,373 |
| 15m Tail sampled rounds | 339 |
| 1h touch/Tail | 0 |

The NDJSON line counts are physical retained rows. Summary counts are logical,
deduplicated/model-specific counts and therefore are not expected to match the
physical line counts exactly.

## Integrity checks

Key source-file SHA-256 values:

| File | SHA-256 |
|---|---|
| `data/runtime-state.json` | `b04c575f3db7b5b658316b4a8ab5e1d65c38988060a230c5fed5842a5e5f9fee` |
| `data-lab/pm-5m-touch/round-results.ndjson` | `0e99c7e5e332f0a976eccb7d02cc54eb8ffe3009a573105e72d54bdea2504668` |
| `data-lab/pm-5m-touch/touches.ndjson` | `51e50bc148183a4d604364a8ba8863d8a94e0888c3823c68f751e40060584eca` |
| `data-lab/pm-5m-tail/samples.ndjson` | `dbadb05089f5051152472b04e307abe838558bb071068e5e6c68c69a4420157c` |
| `data-lab/pm-5m-tail/tail-results.ndjson` | `be27f713de0c0def147c3324c1b9e391e031617eeb4b5f3328d7cda0e5e39427` |
| `data-lab/pm-15m-touch/round-results.ndjson` | `7cb6e0119628af3c9de86d0adc1b1d4a309e3c99dd7b2c4f59a9e08d6c0c7a3e` |
| `data-lab/pm-15m-tail/samples.ndjson` | `80702af743d1cf5bf409e5cb2f88f191fb343f64f439d3c41a6ef9697f95b2e4` |

## Same-host snapshot

A read-only snapshot was created after the source checksums were collected:

- Archive: `/root/apps/poly-btc5m-archives/poly-btc5m-research-v1-2026-08-08.tar.gz`
- Size: 24 MiB
- Mode: `0400`, owner `root`
- SHA-256: `a362eaf6910094a08f4e8434481c298962d705065a66fe81f06671c941e647ff`
- Check file: the same path with `.sha256` appended
- Verification: `sha256sum -c` passed
- Readability: a complete `tar -tzf` traversal passed

This snapshot protects against accidental changes in the application directory,
but it is stored on the same server disk. It is not a disaster-recovery backup.
Before the server becomes the authoritative Paper data collector, copy this
snapshot and future daily backups to an independently managed destination.

## Rebuild invariants

The Paper rebuild must preserve these constraints:

1. No live signing credential is required or mounted by the Paper service.
2. Paper execution cannot call a live order-submission path.
3. The durable ledger has no record-count retention cap.
4. API and dashboard limits are pagination/read-model limits only.
5. Every record is attributable to a run, strategy, configuration hash, code
   SHA, fill-model version, profile, and round.
6. Dual-only, Tail-only, and combined experiments use isolated virtual ledgers.
7. Historical events are append-only; mutable current state is derived from
   those events.
8. Deployment must not overwrite `data/`, `data-lab/`, or Paper ledger files.

