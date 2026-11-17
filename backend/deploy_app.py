import logging

class _RedactShortcutQueries(logging.Filter):
    def filter(self, record):
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
            if args[2].startswith('/api/shortcuts/') and '?' in args[2]:
                record.args = (*args[:2], args[2].split('?', 1)[0] + '?[redacted]', *args[3:])
        return True

logging.getLogger('uvicorn.access').addFilter(_RedactShortcutQueries())

from pathlib import Path
from fastapi.staticfiles import StaticFiles
from app.main import app

@app.middleware('http')
async def updateable_pwa_assets(request, call_next):
    response = await call_next(request)
    if request.url.path in ('/', '/index.html', '/sw.js', '/registerSW.js', '/manifest.webmanifest'):
        response.headers['Cache-Control'] = 'no-cache'
    return response

app.mount('/', StaticFiles(directory=Path(__file__).resolve().parent.parent / 'frontend' / 'dist', html=True), name='frontend')
