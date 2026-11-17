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
