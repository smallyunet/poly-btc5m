# Paper Docker runtime

Use this guide for an isolated Paper worker and dashboard.

```bash
cp .env.example .env.paper
docker compose --env-file .env.paper -f docker-compose.prod.yml config
docker compose --env-file .env.paper -f docker-compose.prod.yml up --build api
```

Verify that `data/paper.sqlite` is host-persisted and that no wallet credential
exists in the rendered Compose environment.
