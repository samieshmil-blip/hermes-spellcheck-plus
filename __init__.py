"""Spellcheck Plus — desktop half only.

Everything user-visible lives in ``desktop/plugin.js`` (the renderer half that
registers the composer context-menu provider and the Settings page). This module
exists because every Hermes plugin package needs a ``register`` entry point even
when it registers nothing on the agent side.
"""

__version__ = "0.2.0"


def register(ctx):  # noqa: ARG001 - the plugin host passes its context
    """No agent-side tools, hooks, middleware or commands."""
    return None
