# AP Invoice Decisioning — single container: FastAPI + SQLite on a mounted volume.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    DATA_DIR=/data PORT=8000

WORKDIR /srv
COPY backend/requirements.txt /srv/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend /srv/backend
# fixtures power the "sample invoices" buttons; small, ship them.
# reviewer-demo.json is the onboarding collection's catalogue — without it
# /api/samples returns nothing and the "Upload from dataset" page has no
# documents to offer, so it ships alongside the PDFs it describes.
COPY fixtures/pdfs /srv/fixtures/pdfs
COPY fixtures/reviewer-demo.json /srv/fixtures/reviewer-demo.json

# the SQLite database and uploaded PDFs live here — mount a persistent volume on /data
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+__import__('os').environ.get('PORT','8000')+'/api/health').status==200 else 1)"

CMD ["sh", "-c", "python -m uvicorn app.main:app --app-dir /srv/backend --host 0.0.0.0 --port ${PORT}"]
