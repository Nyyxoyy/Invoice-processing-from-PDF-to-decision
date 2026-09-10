# Invoice desk — AP invoice decisioning

Vendor invoice PDF in, explained accounts-payable decision out. The model only reads the document; code verifies every value, decides all money, and explains itself. Two roles: invoice reviewer (approves) and procurement admin (suppliers, purchase orders, requests).

- Plan: `PLAN.md` · Implementation record: `IMPLEMENTATION.md` · UX audit: `UX_FINDINGS.md`
- Run locally: `python -m venv venv && venv/bin/pip install -r backend/requirements.txt`, put `GEMINI_API_KEY` in `.env`, then `venv/bin/python -m uvicorn app.main:app --port 8321 --app-dir backend` and open http://localhost:8321 (codes `admin-demo` / `reviewer-demo`).
- Tests: `venv/bin/python -m pytest backend/tests -q`
- Deploy: `Dockerfile` + `render.yaml` (Render free tier; set `GEMINI_API_KEY`, `ADMIN_ACCESS_CODE`, `REVIEWER_ACCESS_CODE` in the dashboard). On the free tier the workspace resets to its seeded state after inactivity.
