"""Check Astra against live catalogs for the credentials Hermes can use.

Return only availability to the sidecar. No external Codex cache, synthesized
model names, tokens, or upstream error bodies cross this boundary.
"""

import contextlib
import json
import logging
import sys


def astra_available():
    import httpx
    from hermes_cli.runtime_provider import resolve_runtime_provider

    runtime = resolve_runtime_provider(requested="openai-codex", target_model="gpt-6-astra")
    if runtime.get("base_url", "").rstrip("/") != "https://chatgpt.com/backend-api/codex":
        return None
    pool = runtime.get("credential_pool")
    # Reuse the same refreshed, eligible pool as inference. Checking all of its
    # credentials avoids offering a model that a later rotation cannot serve.
    tokens = {
        entry.runtime_api_key or entry.access_token
        for entry in pool._available_entries(refresh=True)
    } if pool else {runtime.get("api_key")}
    if not tokens or not all(isinstance(token, str) and token for token in tokens):
        return None

    unknown = False
    with httpx.Client(timeout=5, follow_redirects=False) as client:
        for token in tokens:
            try:
                response = client.get(
                    "https://chatgpt.com/backend-api/codex/models",
                    params={"client_version": "1.0.0"},
                    headers={"Authorization": f"Bearer {token}"},
                )
                response.raise_for_status()
                data = response.json()
                models = data.get("models") if isinstance(data, dict) else None
                if not isinstance(models, list):
                    unknown = True
                    continue
                if not any(
                    isinstance(model, dict)
                    and model.get("slug") == "gpt-6-astra"
                    and str(model.get("visibility", "")).strip().lower() not in {"hide", "hidden"}
                    for model in models
                ):
                    return False
            except Exception:
                unknown = True
    return None if unknown else True


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    try:
        # Hermes helpers may print operational notices. Keep stdout JSON-only.
        with contextlib.redirect_stdout(sys.stderr):
            available = astra_available()
    except Exception:
        available = None
    print(json.dumps({"astraAvailable": available}))
