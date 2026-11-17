# Macro Tracker Backend

FastAPI backend for the calorie & macronutrient tracking PWA featuring:
- **Simple Email + 4–6 digit PIN authentication** (`hashlib.scrypt` + HMAC-SHA256 bearer tokens and `HttpOnly`, `SameSite=lax` persistent `macro_session` cookies)
- **Mifflin-St Jeor calibration** with protein-prioritized macro targets and manual override support
- **Gemini multimodal photo macro extraction** (`google-genai` SDK with zero-dependency `urllib.request` REST fallback) using everyday reference objects in the photo for scale calibration and direct nutrition-label reading
- **Timezone-accurate daily meal logs & dashboard** (`date` + JS `tz_offset_minutes` converted to `[00:00, 24:00)` local calendar bounds in UTC)
- **SQLAlchemy 2.0 ORM** compatible with local SQLite and production PostgreSQL (`psycopg` v3)

---

## Project Structure

```text
macro-tracker/
├── README.md
└── backend/
    ├── .env.example
    ├── requirements.txt
    ├── app/
    │   ├── __init__.py
    │   ├── auth.py
    │   ├── calibration.py
    │   ├── config.py
    │   ├── database.py
    │   ├── gemini_service.py
    │   ├── main.py
    │   ├── models.py
    │   └── schemas.py
    └── tests/
        └── test_api.py
```

---

## Local Setup & Run

```bash
cd macro-tracker/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` and add your Gemini API key (`GEMINI_API_KEY` or `GOOGLE_API_KEY`), then start the development server:

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Interactive API docs will be available at `http://localhost:8000/docs`, and `GET /api/health` returns `{"status": "ok"}`.

### Running Tests

```bash
cd macro-tracker/backend
pytest -v
```

---

## Gemini Photo Analysis Prompt Behavior

The photo analysis prompt (`GEMINI_SYSTEM_INSTRUCTION` & `build_meal_analysis_prompt` in `backend/app/gemini_service.py`) is isolated for benchmarking and enforces:
- **Non-consumed reference objects:** Uses everyday items in frame (spoon, fork, phone, credit card, sealed reference soda can) purely for scale calibration without adding non-food objects or unopened background reference drinks to meal totals unless noted as consumed.
- **Multi-serving containers vs. 1 serving:** Defaults multi-serving tubs or multipack boxes (e.g., "32 oz tub", "12 Bars") to 1 standard serving/unit unless overridden in the user's `note`, documenting the assumed serving in `portion_description` and `notes`.
- **Side sauces & cooking fats:** Splits side sauce cups/ramekins into separate `items[]` entries so users can edit or delete them independently, and accounts realistically for visible butter or oil sheen.

---

## Environment Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:///./macro_tracker.db` | SQLite locally or `postgresql+psycopg://...` in prod (`postgres://` / `postgresql://` are auto-normalized) |
| `GEMINI_API_KEY` | `""` | Gemini API key (process env takes precedence over `.env`) |
| `GOOGLE_API_KEY` | `""` | Alternative Gemini API key env var |
| `GEMINI_MODEL` | `gemini-4-carbon` | Gemini model name used for meal photo analysis |
| `SECRET_KEY` | `change-me-in-prod` | HMAC-SHA256 signing secret for 30-day session tokens |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated allowed origins for browser requests with credentials |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS in production so `macro_session` cookies carry the `Secure` flag |
| `VAPID_PUBLIC_KEY` | `""` | Optional pre-generated URL-safe base64 Web Push public key |
| `VAPID_PRIVATE_KEY` | `""` | Optional pre-generated PKCS8/base64url Web Push private key |
| `VAPID_SUBJECT` | `mailto:admin@macrolens.local` | Contact `mailto:` or URL claim for VAPID JWTs |
| `VAPID_KEYS_FILE` | `.vapid_keys.json` | File path where auto-generated P-256 VAPID keys are persisted if env keys are unset |

---

## Dexter PostgreSQL Deployment Notes

1. **Database Connection:** Provision a PostgreSQL instance on Dexter and set `DATABASE_URL` to your Postgres connection string (either `postgresql+psycopg://user:pass@host:5432/dbname` or standard `postgresql://...` / `postgres://...`, which `app/config.py` normalizes to `postgresql+psycopg://`). Tables (`users`, `meal_entries`, `push_subscriptions`) are auto-created on startup via `Base.metadata.create_all`, and additive columns are safely migrated in `init_db()`.
2. **Security & Persistent PWA Sessions:**
   - Generate a strong random `SECRET_KEY` (e.g., `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`).
   - Set `COOKIE_SECURE=true` so the 30-day `HttpOnly` `macro_session` cookie is sent only over HTTPS.
   - Set `CORS_ORIGINS` to your deployed PWA origin (e.g., `https://macros.yourdomain.com`) if the frontend is hosted on a separate origin.
3. **Gemini Photo Analysis:** Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) and optionally `GEMINI_MODEL` (defaults to `gemini-4-carbon`).
4. **Start Command:**
   ```bash
   uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
   ```
