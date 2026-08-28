#!/usr/bin/env python3
"""JSON adapter for Hermes Skills Hub discovery.

This process intentionally delegates discovery to Hermes' own hub modules and
only translates SkillMeta objects into the sidecar's JSON response shape.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from io import StringIO
from pathlib import Path
from typing import Any

from rich.console import Console


TRUST_RANK = {"builtin": 3, "trusted": 2, "community": 1}
SOURCE_RANK = {"official": 3, "hermes-index": 2}
DEFAULT_LIMITS = {
    "official": 100,
    "hermes-index": 120,
    "skills-sh": 50,
    "well-known": 25,
    "github": 50,
    "clawhub": 50,
    "claude-marketplace": 50,
    "lobehub": 50,
}


def main() -> int:
    try:
        request = json.loads(sys.stdin.read() or "{}")
        response = list_hub_skills(request)
    except Exception as exc:
        print(json.dumps({"error": "hub_query_failed", "message": str(exc)}), file=sys.stderr)
        return 1

    print(json.dumps(response, ensure_ascii=False))
    return 0


def list_hub_skills(request: dict[str, Any]) -> dict[str, Any]:
    action = str(request.get("action") or "list")
    if action == "inspect":
        return inspect_hub_skill(request)
    if action == "install":
        return install_hub_skill(request)

    from tools.skills_hub import GitHubAuth, create_source_router, parallel_search_sources

    query = str(request.get("query") or "").strip()
    source = str(request.get("source") or "all").strip() or "all"
    limit = _clamp_int(request.get("limit"), default=100, low=1, high=250)

    all_results, source_counts, timed_out = parallel_search_sources(
        create_source_router(GitHubAuth()),
        query=query,
        per_source_limits=DEFAULT_LIMITS,
        source_filter=source,
        overall_timeout=30,
    )

    installed_slugs = _installed_skill_slugs()
    deduped = _dedupe(all_results)
    deduped.sort(key=lambda item: (
        -TRUST_RANK.get(getattr(item, "trust_level", ""), 0),
        -SOURCE_RANK.get(getattr(item, "source", ""), 0),
        str(getattr(item, "name", "")).lower(),
    ))

    return {
        "skills": [_serialize(meta, installed_slugs) for meta in deduped[:limit]],
        "sourceCounts": source_counts,
        "timedOutSources": timed_out,
        "query": query,
        "source": source,
    }


def inspect_hub_skill(request: dict[str, Any]) -> dict[str, Any]:
    from hermes_cli.skills_hub import _resolve_source_meta_and_bundle
    from tools.skills_hub import GitHubAuth, create_source_router

    identifier = str(request.get("identifier") or "").strip()
    if not identifier:
        raise ValueError("identifier is required")

    meta, bundle, _matched_source = _resolve_source_meta_and_bundle(
        identifier,
        create_source_router(GitHubAuth()),
    )
    if not meta and not bundle:
        raise ValueError(f"Unknown hub skill: {identifier}")

    skill_md = ""
    files: list[str] = []
    if bundle:
        files = sorted(str(path) for path in bundle.files.keys())
        content = bundle.files.get("SKILL.md")
        if isinstance(content, bytes):
            skill_md = content.decode("utf-8", errors="replace")
        elif isinstance(content, str):
            skill_md = content

    installed_slugs = _installed_skill_slugs()
    serializable = meta or bundle
    base = _serialize(serializable, installed_slugs)
    frontmatter = _frontmatter_fields(skill_md)
    if bundle:
        bundle_name = str(getattr(bundle, "name", "") or identifier.rsplit("/", 1)[-1])
        base = {
            **base,
            "identifier": base["identifier"] or str(getattr(bundle, "identifier", "") or identifier),
            "name": frontmatter.get("name") or base["name"] or bundle_name,
            "slug": _slug(frontmatter.get("name") or base["name"] or bundle_name),
            "source": base["source"] or str(getattr(bundle, "source", "") or ""),
            "trustLevel": base["trustLevel"] or str(getattr(bundle, "trust_level", "") or ""),
            "installed": base["installed"] or _slug(bundle_name) in installed_slugs,
        }
    if frontmatter.get("description"):
        base["description"] = frontmatter["description"]
    if frontmatter.get("tags"):
        base["tags"] = frontmatter["tags"]

    return {
        "skill": {
            **base,
            "content": _strip_frontmatter(skill_md),
            "rawContent": skill_md,
            "files": files,
        },
    }


def install_hub_skill(request: dict[str, Any]) -> dict[str, Any]:
    from hermes_cli.skills_hub import do_install
    from tools.skills_hub import HubLockFile

    identifier = str(request.get("identifier") or "").strip()
    if not identifier:
        raise ValueError("identifier is required")

    force = False
    before = _installed_hub_entries()
    sink = StringIO()
    console = Console(file=sink, force_terminal=False, color_system=None, width=120)

    if "/" in identifier:
        do_install(
            identifier,
            category="",
            force=force,
            console=console,
            skip_confirm=True,
            invalidate_cache=True,
        )
    else:
        _install_resolved_hub_skill(identifier, console=console)

    output = sink.getvalue().strip()
    after = HubLockFile().list_installed()
    entry = _find_installed_hub_entry(after, identifier)
    installed = entry is not None
    changed = installed and before.get(str(entry.get("name") or "")) != entry

    return {
        "installed": installed,
        "changed": changed,
        "skill": _serialize_lock_entry(entry) if entry else None,
        "message": _last_output_line(output) or (
            "Skill installed." if installed else "Installation did not complete."
        ),
        "output": output,
    }


def _install_resolved_hub_skill(identifier: str, console: Console) -> None:
    from hermes_cli.skills_hub import _resolve_source_meta_and_bundle
    from tools.skills_guard import format_scan_report, scan_skill, should_allow_install
    from tools.skills_hub import (
        GitHubAuth,
        HubLockFile,
        append_audit_log,
        create_source_router,
        ensure_hub_dirs,
        install_from_quarantine,
        quarantine_bundle,
    )

    ensure_hub_dirs()
    console.print(f"\n[bold]Fetching:[/] {identifier}")
    meta, bundle, _matched_source = _resolve_source_meta_and_bundle(
        identifier,
        create_source_router(GitHubAuth()),
    )
    if not bundle:
        console.print(f"[bold red]Error:[/] Could not fetch '{identifier}' from any source.")
        return

    category = ""
    if bundle.source == "official":
        id_parts = bundle.identifier.split("/")
        if len(id_parts) >= 3:
            category = id_parts[1]

    lock = HubLockFile()
    existing = lock.get_installed(bundle.name)
    if existing:
        console.print(f"[yellow]Warning:[/] '{bundle.name}' is already installed at {existing['install_path']}")
        return

    try:
        q_path = quarantine_bundle(bundle)
    except ValueError as exc:
        console.print(f"[bold red]Installation blocked:[/] {exc}\n")
        append_audit_log("BLOCKED", bundle.name, bundle.source, bundle.trust_level, "invalid_path", str(exc))
        return

    console.print(f"[dim]Quarantined to {q_path.relative_to(q_path.parent.parent.parent)}[/]")
    console.print("[bold]Running security scan...[/]")
    scan_source = getattr(bundle, "identifier", "") or getattr(meta, "identifier", "") or identifier
    result = scan_skill(q_path, source=scan_source)
    console.print(format_scan_report(result))

    allowed, reason = should_allow_install(result, force=False)
    if not allowed:
        console.print(f"\n[bold red]Installation blocked:[/] {reason}")
        shutil.rmtree(q_path, ignore_errors=True)
        append_audit_log(
            "BLOCKED",
            bundle.name,
            bundle.source,
            bundle.trust_level,
            result.verdict,
            f"{len(result.findings)}_findings",
        )
        return

    try:
        install_dir = install_from_quarantine(q_path, bundle.name, category, bundle, result)
    except ValueError as exc:
        console.print(f"[bold red]Installation blocked:[/] {exc}\n")
        shutil.rmtree(q_path, ignore_errors=True)
        append_audit_log("BLOCKED", bundle.name, bundle.source, bundle.trust_level, "invalid_path", str(exc))
        return

    from tools.skills_hub import SKILLS_DIR
    console.print(f"[bold green]Installed:[/] {install_dir.relative_to(SKILLS_DIR)}")
    console.print(f"[dim]Files: {', '.join(bundle.files.keys())}[/]\n")

    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache

        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception:
        pass


def _installed_hub_entries() -> dict[str, dict[str, Any]]:
    from tools.skills_hub import HubLockFile

    return {str(entry.get("name") or ""): entry for entry in HubLockFile().list_installed()}


def _find_installed_hub_entry(entries: list[dict[str, Any]], identifier: str) -> dict[str, Any] | None:
    identifier = identifier.strip()
    identifier_tail = _slug(identifier.rsplit("/", 1)[-1])
    for entry in entries:
        entry_identifier = str(entry.get("identifier") or "")
        if entry_identifier == identifier:
            return entry
    for entry in entries:
        name = str(entry.get("name") or "")
        if identifier_tail and _slug(name) == identifier_tail:
            return entry
    return None


def _serialize_lock_entry(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": str(entry.get("name") or ""),
        "source": str(entry.get("source") or ""),
        "identifier": str(entry.get("identifier") or ""),
        "trustLevel": str(entry.get("trust_level") or ""),
        "scanVerdict": str(entry.get("scan_verdict") or ""),
        "contentHash": str(entry.get("content_hash") or ""),
        "installPath": str(entry.get("install_path") or ""),
        "files": [str(path) for path in (entry.get("files") or [])],
        "installedAt": entry.get("installed_at"),
        "updatedAt": entry.get("updated_at"),
    }


def _last_output_line(output: str) -> str:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return lines[-1] if lines else ""


def _dedupe(items: list[Any]) -> list[Any]:
    seen: dict[str, Any] = {}
    for item in items:
        name_key = _slug(str(getattr(item, "name", "") or getattr(item, "identifier", "")))
        key = name_key or str(getattr(item, "identifier", ""))
        rank = (
            TRUST_RANK.get(getattr(item, "trust_level", ""), 0),
            SOURCE_RANK.get(getattr(item, "source", ""), 0),
        )
        prev = seen.get(key)
        if prev is None:
            seen[key] = item
            continue
        prev_rank = (
            TRUST_RANK.get(getattr(prev, "trust_level", ""), 0),
            SOURCE_RANK.get(getattr(prev, "source", ""), 0),
        )
        if rank > prev_rank:
            seen[key] = item
    return list(seen.values())


def _serialize(meta: Any, installed_slugs: set[str]) -> dict[str, Any]:
    name = str(getattr(meta, "name", "") or "")
    slug = _slug(name)
    return {
        "identifier": str(getattr(meta, "identifier", "") or ""),
        "name": name,
        "slug": slug,
        "description": str(getattr(meta, "description", "") or ""),
        "source": str(getattr(meta, "source", "") or ""),
        "trustLevel": str(getattr(meta, "trust_level", "") or ""),
        "repo": getattr(meta, "repo", None),
        "path": getattr(meta, "path", None),
        "tags": [str(tag) for tag in (getattr(meta, "tags", []) or []) if str(tag).strip()],
        "installed": slug in installed_slugs,
    }


def _strip_frontmatter(raw: str) -> str:
    if not raw.startswith("---"):
        return raw
    end = raw.find("\n---", 3)
    if end < 0:
        return raw
    return raw[end + 4:].lstrip("\r\n")


def _frontmatter_fields(raw: str) -> dict[str, Any]:
    if not raw.startswith("---"):
        return {}
    end = raw.find("\n---", 3)
    if end < 0:
        return {}
    yaml_text = raw[3:end]
    try:
        import yaml

        parsed = yaml.safe_load(yaml_text)
    except Exception:
        parsed = None
    if not isinstance(parsed, dict):
        return {}

    fields: dict[str, Any] = {}
    name = parsed.get("name")
    if isinstance(name, str) and name.strip():
        fields["name"] = name.strip()
    description = parsed.get("description")
    if isinstance(description, str) and description.strip():
        fields["description"] = description.strip()
    tags = parsed.get("tags")
    if isinstance(tags, list):
        fields["tags"] = [str(tag) for tag in tags if str(tag).strip()]
    return fields


def _installed_skill_slugs() -> set[str]:
    home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    skills_dir = home / "skills"
    if not skills_dir.is_dir():
        return set()

    slugs: set[str] = set()
    for skill_md in skills_dir.rglob("SKILL.md"):
        if ".hub" in skill_md.parts:
            continue
        name = _frontmatter_name(skill_md) or skill_md.parent.name
        skill_slug = _slug(name)
        if skill_slug:
            slugs.add(skill_slug)
    return slugs


def _frontmatter_name(path: Path) -> str:
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    if not raw.startswith("---"):
        return ""
    end = raw.find("\n---", 3)
    if end < 0:
        return ""
    for line in raw[3:end].splitlines():
        if line.lstrip().startswith("name:"):
            value = line.split(":", 1)[1].strip()
            return value.strip("\"'")
    return ""


def _slug(raw: str) -> str:
    value = raw.lower().replace("_", "-")
    value = re.sub(r"[^a-z0-9-]+", "-", value)
    value = re.sub(r"-{2,}", "-", value)
    return value.strip("-")


def _clamp_int(value: Any, *, default: int, low: int, high: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(low, min(high, parsed))


if __name__ == "__main__":
    raise SystemExit(main())
