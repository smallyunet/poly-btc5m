# Paper runtime troubleshooting

Check the Paper service in this order:

1. `docker compose -f docker-compose.prod.yml ps`
2. `docker compose -f docker-compose.prod.yml logs -f api`
3. `/api/health` and public Binance/CLOB websocket freshness
4. `/api/paper/stats` run identity and event counts
5. host space and permissions for `data/paper.sqlite*`

Do not solve data-feed failures by adding trading credentials. Rotate
`PAPER_RUN_ID` only when the experiment assumptions actually change.
