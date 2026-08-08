# Paper server deployment

Use `deploy/deploy-a.sh` to sync and start `docker-compose.prod.yml`. Before
deploying, verify the enabled profiles, `PAPER_RUN_ID`, host `data/` volume, and
backup policy. After deployment, inspect `/api/health`, `/api/paper/stats`, and
fresh API logs. Never add wallet credentials or an authenticated CLOB client.
