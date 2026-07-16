from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    root: Path = ROOT
    cache_dir: Path = ROOT / "cache"
    model_dir: Path = ROOT / "models"
    min_lat: float = 5.5
    max_lat: float = 20.5
    min_lng: float = 97.5
    max_lng: float = 105.7
    grid_step: float = 0.25
    gistda_key: str = os.getenv("GISTDA_KEY", "")
    google_maps_api_key: str = os.getenv("GOOGLE_MAPS_API_KEY", "")
    gistda_pixel_mode: str = os.getenv("GISTDA_FLOOD_PIXEL_MODE", "visible")

    @property
    def risk_file(self) -> Path:
        return self.cache_dir / "risk_latest.json"


settings = Settings()