# Server deployment

`deploy-a.sh` synchronizes the repository, creates `.env` from `.env.example`
when needed, builds the image, and starts `docker-compose.prod.yml`.

The deployed application is Paper-only. Do not add wallet credentials to the
server environment; the application has no authenticated trading client.

Each deployment creates and persists a new `PAPER_RUN_ID` so code, configuration,
and fill-model changes cannot reuse an incompatible ledger run. Set
`DEPLOY_PAPER_RUN_ID` only when an explicit durable run identifier is required.
Verify the enabled profile set and ensure `data/` is included in the server
backup policy. The deploy script preserves remote certificates and restores
them from the local ignored `certs/` directory only when they are missing.

```bash
./deploy/deploy-a.sh
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api
```
