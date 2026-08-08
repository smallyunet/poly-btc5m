# Server deployment

`deploy-a.sh` synchronizes the repository, creates `.env` from `.env.example`
when needed, builds the image, and starts `docker-compose.prod.yml`.

The deployed application is Paper-only. Do not add wallet credentials to the
server environment; the application has no authenticated trading client.

Before deployment, choose a durable `PAPER_RUN_ID`, verify the enabled profile
set, and ensure `data/` is included in the server backup policy.

```bash
./deploy/deploy-a.sh
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api
```
