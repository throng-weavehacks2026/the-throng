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
