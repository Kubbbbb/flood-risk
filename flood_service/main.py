from __future__ import annotations

import asyncio
import io
import json
import math
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import httpx
import numpy as np
import torch
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image
from shapely.geometry import box, shape

from .config import settings
from .model import FloodRiskLSTM

BANGKOK = timezone(timedelta(hours=7))
GISTDA_MAP = "https://api-gateway.gistda.or.th/api/2.0/resources/maps/flood-freq/wmts/{z}/{x}/{y}.png"
GISTDA_FEATURES = "https://api-gateway.gistda.or.th/api/2.0/resources/features/flood/1day?limit=500&offset=0"
WEATHER = "https://api.open-meteo.com/v1/forecast"
FLOOD = "https://flood-api.open-meteo.com/v1/flood"
ELEVATION = "https://maps.googleapis.com/maps/api/elevation/json"
SEQUENCE_LENGTH = 30


def daily_path(name: str) -> Path:
    settings.cache_dir.mkdir(exist_ok=True)
    return settings.cache_dir / f"{name}_{datetime.now(BANGKOK).date().isoformat()}.json"


def read_daily(name: str) -> Any | None:
    path = daily_path(name)
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def cells() -> list[dict[str, float]]:
    lats = np.arange(settings.min_lat, settings.max_lat, settings.grid_step)
    lngs = np.arange(settings.min_lng, settings.max_lng, settings.grid_step)
    return [{"lat": round(float(lat + settings.grid_step / 2), 5), "lng": round(float(lng + settings.grid_step / 2), 5)} for lat in lats for lng in lngs]


def mercator_tile(lat: float, lng: float, z: int) -> tuple[int, int, int, int]:
    n = 2**z
    x_float = (lng + 180.0) / 360.0 * n
    lat_rad = math.radians(max(min(lat, 85.05112878), -85.05112878))
    y_float = (1 - math.asinh(math.tan(lat_rad)) / math.pi) / 2 * n
    x, y = int(x_float), int(y_float)
    return x, y, int((x_float - x) * 256), int((y_float - y) * 256)


def flood_pixel_ratio(image_bytes: bytes, px: int, py: int) -> float:
    """Estimate coverage near a grid centre from a transparent GISTDA WMTS tile."""
    img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    arr = np.asarray(img)
    window = arr[max(0, py - 8):min(256, py + 8), max(0, px - 8):min(256, px + 8)]
    alpha = window[..., 3] > 20
    if settings.gistda_pixel_mode == "visible":
        rgb = window[..., :3]
        alpha &= np.any(rgb < 245, axis=-1)
    return float(alpha.mean()) if alpha.size else 0.0


async def fetch_json(client: httpx.AsyncClient, url: str, **kwargs: Any) -> Any:
    for attempt in range(5):
        response = await client.get(url, **kwargs)
        if response.status_code != 429:
            response.raise_for_status()
            return response.json()
        retry_after = response.headers.get("Retry-After")
        delay = min(float(retry_after), 60.0) if retry_after and retry_after.isdigit() else min(5 * (attempt + 1), 30)
        await asyncio.sleep(delay)
    response.raise_for_status()
    return response.json()


async def gistda_frequency(client: httpx.AsyncClient, grid: list[dict[str, float]]) -> dict[str, float]:
    cached = read_daily("gistda_frequency")
    if cached is not None:
        return cached
    if not settings.gistda_key:
        raise RuntimeError("GISTDA_KEY is required to collect GISTDA flood-frequency tiles")
    z, tiles = 8, {}
    for cell in grid:
        x, y, _, _ = mercator_tile(cell["lat"], cell["lng"], z)
        tiles[(x, y)] = None
    headers = {"API-Key": settings.gistda_key}
    async def get_tile(x: int, y: int) -> tuple[tuple[int, int], bytes]:
        url = GISTDA_MAP.format(z=z, x=x, y=y)
        response = await client.get(url, headers=headers)
        
        if response.status_code == 404:
            transparent = Image.new("RGBA", (256, 256), (255, 255, 255, 0))
            buffer = io.BytesIO()
            transparent.save(buffer, format="PNG")
            return (x, y), buffer.getvalue()
        response.raise_for_status()
        return (x, y), response.content
    for key, data in await asyncio.gather(*(get_tile(*tile) for tile in tiles)):
        tiles[key] = data
    values = {}
    for cell in grid:
        x, y, px, py = mercator_tile(cell["lat"], cell["lng"], z)
        values[cell_key(cell)] = flood_pixel_ratio(tiles[(x, y)], px, py)
    write_json(daily_path("gistda_frequency"), values)
    return values


async def gistda_current(client: httpx.AsyncClient, grid: list[dict[str, float]]) -> dict[str, bool]:
    cached = read_daily("gistda_current")
    if cached is not None:
        return cached
    if not settings.gistda_key:
        raise RuntimeError("GISTDA_KEY is required to collect GISTDA current flood features")
    data = await fetch_json(client, GISTDA_FEATURES, headers={"API-Key": settings.gistda_key})
    polygons = []
    for feature in data.get("features", []):
        geometry = feature.get("geometry")
        if geometry:
            try: polygons.append(shape(geometry))
            except Exception: pass
    half = settings.grid_step / 2
    result = {cell_key(c): any(p.intersects(box(c["lng"] - half, c["lat"] - half, c["lng"] + half, c["lat"] + half)) for p in polygons) for c in grid}
    write_json(daily_path("gistda_current"), result)
    return result


async def open_meteo(client: httpx.AsyncClient, grid: list[dict[str, float]]) -> dict[str, Any]:
    cached = read_daily("open_meteo")
    if cached is not None:
        return cached
    result: dict[str, Any] = {}
   
    for start in range(0, len(grid), 100):
        batch = grid[start:start + 100]
        params = {"latitude": ",".join(str(c["lat"]) for c in batch), "longitude": ",".join(str(c["lng"]) for c in batch)}
        weather_task = fetch_json(client, WEATHER, params={**params, "daily": "precipitation_sum", "forecast_days": 7, "timezone": "Asia/Bangkok"})
        flood_task = fetch_json(client, FLOOD, params={**params, "daily": "river_discharge", "forecast_days": 16, "past_days": 30, "timezone": "Asia/Bangkok"})
        weather, flood = await asyncio.gather(weather_task, flood_task)
        weather_items, flood_items = (weather if isinstance(weather, list) else [weather]), (flood if isinstance(flood, list) else [flood])
        for cell, w, f in zip(batch, weather_items, flood_items):
            rain = [v or 0.0 for v in w.get("daily", {}).get("precipitation_sum", [])]
            discharge = [v if v is not None else 0.0 for v in f.get("daily", {}).get("river_discharge", [])]
            history = discharge[:SEQUENCE_LENGTH] or [0.0] * SEQUENCE_LENGTH
            forecast = discharge[SEQUENCE_LENGTH:SEQUENCE_LENGTH + 7] or [history[-1]]
            mean = max(float(np.mean(history)), 0.01)
            result[cell_key(cell)] = {"rain": rain, "history": history, "current": history[-1], "mean30": mean, "max7": max(forecast)}
      
        await asyncio.sleep(2.5)
    write_json(daily_path("open_meteo"), result)
    return result


async def elevations(client: httpx.AsyncClient, grid: list[dict[str, float]]) -> dict[str, float]:
    path = settings.cache_dir / "elevation_static.json"
    if path.exists(): return json.loads(path.read_text(encoding="utf-8"))
    if not settings.google_maps_api_key:
        raise RuntimeError("GOOGLE_MAPS_API_KEY is required to collect static elevation")
    result: dict[str, float] = {}
    for start in range(0, len(grid), 500):
        batch = grid[start:start + 500]
        
        payload = {"locations": [{"lat": c["lat"], "lng": c["lng"]} for c in batch], "key": settings.google_maps_api_key}
        response = await client.post(ELEVATION, json=payload)
        if response.status_code >= 400:
            response = await client.get(ELEVATION, params={"locations": "|".join(f'{c["lat"]},{c["lng"]}' for c in batch), "key": settings.google_maps_api_key})
        response.raise_for_status()
        items = response.json().get("results", [])
        for cell, item in zip(batch, items): result[cell_key(cell)] = float(item.get("elevation", 0.0))
    write_json(path, result)
    return result


def cell_key(cell: dict[str, float]) -> str:
    return f'{cell["lat"]:.5f},{cell["lng"]:.5f}'


def build_sequences(grid: list[dict[str, float]], meteo: dict[str, Any], elev: dict[str, float], freq: dict[str, float]) -> tuple[np.ndarray, np.ndarray]:
    maximum_elevation = max(elev.values(), default=1.0) or 1.0
    sequences, labels = [], []
    for c in grid:
        key = cell_key(c)
        data = meteo[key]
        hist, rainfall = data["history"][-SEQUENCE_LENGTH:], data["rain"]
        mean = data["mean30"]
        rows = []
        for day, discharge in enumerate(hist):
            observed_rain = [0.0] * SEQUENCE_LENGTH + rainfall
            pos = min(day + SEQUENCE_LENGTH, len(observed_rain) - 1)
            r3 = sum(observed_rain[max(0, pos - 2):pos + 1])
            r7 = sum(observed_rain[max(0, pos - 6):pos + 1])
            rows.append([min(discharge / mean, 5) / 5, min(r3 / 150, 1), min(r7 / 300, 1), 1 - min(elev.get(key, 0) / maximum_elevation, 1), freq.get(key, 0.0)])
        sequences.append(rows)
        
        labels.append(min(1.0, freq.get(key, 0.0) * min(data["current"] / mean, 2.0)))
    return np.asarray(sequences, dtype=np.float32), np.asarray(labels, dtype=np.float32)


def train_and_predict(sequence: np.ndarray, labels: np.ndarray, meteo: dict[str, Any], grid: list[dict[str, float]], freq: dict[str, float], current: dict[str, bool]) -> list[float]:
    torch.manual_seed(42)
    model = FloodRiskLSTM()
    x, y = torch.tensor(sequence), torch.tensor(labels)
    optimiser = torch.optim.Adam(model.parameters(), lr=0.002)
    for _ in range(25):
        optimiser.zero_grad(); prediction = model(x)
        loss = torch.nn.functional.binary_cross_entropy(prediction, y)
        loss.backward(); optimiser.step()
    settings.model_dir.mkdir(exist_ok=True)
    torch.save(model.state_dict(), settings.model_dir / "flood_lstm.pt")
    with torch.no_grad(): forecast = model(x).numpy()
   
    return [float(max(value, 0.85 if current.get(cell_key(c), False) else 0.0)) for value, c in zip(forecast, grid)]


async def refresh_prediction(force: bool = False) -> dict[str, Any]:
    if settings.risk_file.exists() and not force:
        modified = datetime.fromtimestamp(settings.risk_file.stat().st_mtime, BANGKOK).date()
        if modified == datetime.now(BANGKOK).date(): return json.loads(settings.risk_file.read_text(encoding="utf-8"))
    grid = cells()
    async with httpx.AsyncClient(timeout=60.0) as client:
        freq, current, meteo, elev = await asyncio.gather(gistda_frequency(client, grid), gistda_current(client, grid), open_meteo(client, grid), elevations(client, grid))
    sequence, labels = build_sequences(grid, meteo, elev, freq)
    scores = train_and_predict(sequence, labels, meteo, grid, freq, current)
    payload = {"timestamp": datetime.now(timezone.utc).isoformat(), "cells": []}
    for cell, score, label in zip(grid, scores, labels):
        data = meteo[cell_key(cell)]
        ratio = data["current"] / data["mean30"]
        current_score = max(float(label), 0.85 if current.get(cell_key(cell), False) else 0.0)
        forecast_signal = min(1, ratio * 0.30 + data["max7"] / data["mean30"] * 0.35)
        payload["cells"].append({"lat": cell["lat"], "lng": cell["lng"], "risk_current": int(round(min(100, current_score * 100))), "risk_7d": int(round(min(100, max(score, forecast_signal) * 100))), "flood_freq_score": round(freq.get(cell_key(cell), 0.0), 4), "discharge_ratio": round(ratio, 3), "rainfall_7d": round(sum(data["rain"]), 2)})
    write_json(settings.risk_file, payload)
    return payload


app = FastAPI(title="FloodSense LSTM Risk API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])
settings.cache_dir.mkdir(exist_ok=True)
app.mount("/cache", StaticFiles(directory=settings.cache_dir), name="cache")
scheduler = AsyncIOScheduler(timezone="Asia/Bangkok")

@app.on_event("startup")
async def startup() -> None:
    scheduler.add_job(refresh_prediction, "cron", hour=6, minute=0, id="daily-flood-refresh", replace_existing=True)
    scheduler.start()

@app.on_event("shutdown")
async def shutdown() -> None:
    scheduler.shutdown(wait=False)

@app.post("/predict")
async def predict() -> dict[str, Any]:
    try: return await refresh_prediction()
    except (httpx.HTTPError, RuntimeError) as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "risk_file": str(settings.risk_file)}
