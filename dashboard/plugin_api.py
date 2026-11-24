"""Spellcheck Plus backend, mounted at /api/plugins/spellcheck-plus/.

The plugin needs no backend to work: dictionaries ship inside
``desktop/plugin.js`` and suggestions are computed in the renderer. This router
exists so the package has the standard layout, and it gives the UI (and anyone
debugging) one honest read-only endpoint describing what the build contains.

No secrets, no profile paths, no filesystem access beyond this file's own data.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()

# Kept in one place: the desktop half embeds exactly these dictionaries.
LANGUAGES = {
    "ru": {"label": "Русский", "words": 200000, "source": "FrequencyWords (ru, 2018)"},
    "en": {"label": "English", "words": 46691, "source": "FrequencyWords (en, 2018)"},
}


@router.get("/meta")
def meta() -> dict:
    """What this build ships: languages, dictionary sizes, engine limits."""
    return {
        "plugin": "spellcheck-plus",
        "version": "0.1.0",
        "languages": LANGUAGES,
        "engine": {
            "max_edit_distance": 2,
            "distance2_budget_ms": 40,
            "distance2_max_candidates": 20000,
            "suggestions_per_word": 4,
        },
    }
