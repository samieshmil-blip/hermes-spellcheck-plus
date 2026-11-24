"""Spellcheck Plus backend, mounted at /api/plugins/spellcheck-plus/.

The plugin needs no backend to work: dictionaries ship inside
``desktop/plugin.js`` and suggestions are computed in the renderer. This router
exists so the package has the standard layout, and it gives the UI (and anyone
debugging) one honest read-only endpoint describing what the build contains.

No secrets, no profile paths, no filesystem access.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()

VERSION = "0.2.0"

# Kept in one place: the desktop half embeds exactly these dictionaries.
LANGUAGES = {
    "ru": {"label": "Русский", "words": 200000},
    "en": {"label": "English", "words": 46691},
    "uk": {"label": "Українська", "words": 44303},
    "de": {"label": "Deutsch", "words": 49305},
    "fr": {"label": "Français", "words": 46687},
    "es": {"label": "Español", "words": 49520},
    "it": {"label": "Italiano", "words": 45114},
    "pt": {"label": "Português", "words": 43952},
    "pl": {"label": "Polski", "words": 49635},
    "tr": {"label": "Türkçe", "words": 48515},
}


@router.get("/meta")
def meta() -> dict:
    """What this build ships: languages, dictionary sizes, engine limits."""
    return {
        "plugin": "spellcheck-plus",
        "version": VERSION,
        "languages": LANGUAGES,
        "defaults": ["ru", "en"],
        "engine": {
            "max_edit_distance": 2,
            "distance2_budget_ms": 45,
            "distance2_max_candidates": 30000,
            "suggestions_per_word": 4,
        },
        "dictionary_source": "https://github.com/hermitdave/FrequencyWords (MIT, 2018)",
    }
