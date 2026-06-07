# Backend

Run the orchestrator backend:

```bash
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8787 --reload
```

Live OpenAI mode reads `../.env` automatically:

```bash
OPENAI_API_KEY=...
```

Optional Weave tracing:

```bash
set WANDB_API_KEY=...
set WEAVE_PROJECT=the-throng
```

Optional Redis claim arbitration:

```bash
set REDIS_URL=redis://127.0.0.1:6379/0
```

Current endpoints:

- `GET /api/orchestrator/status` reports OpenAI, Redis, and Weave health.
- `POST /api/orchestrator/decide` asks the director for legal game actions.
- `POST /api/critic/reflect` asks the critic to produce a reusable strategy.
- `POST /api/claims/claim` performs Redis `SET NX` resource arbitration, with an in-memory fallback.
