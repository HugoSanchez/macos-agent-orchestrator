#!/usr/bin/env python3
"""verso MCP bridge for Hermes.

This server exposes verso's local app bridge to Hermes: connection flows,
connection state, Composio tool discovery, schema inspection, and execution.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Literal

import anyio
import mcp.types as types
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.tools.base import Tool
from mcp.server.fastmcp.utilities.func_metadata import ArgModelBase, FuncMetadata
from mcp.server.stdio import stdio_server


SERVER_NAME = "verso"
ORCHESTRATOR_BASE_URL = os.environ.get("VERSO_ORCHESTRATOR_BASE_URL", "").rstrip("/")
COMPOSIO_TOOLS_MANIFEST = os.environ.get("VERSO_COMPOSIO_TOOLS_MANIFEST", "").strip()
# The native app issues a fresh loopback token for every launch. The MCP
# process is configured with an explicit environment by Hermes, so retain and
# send it with every bridge request instead of relying on inherited process
# state. Without this, the authenticated sidecar correctly rejects memory and
# connected-tool calls with HTTP 401.
SIDECAR_AUTH_SECRET = os.environ.get("VERSO_SIDECAR_AUTH_SECRET", "").strip()
# Memory tool surface for this Hermes profile: "full" or unset/anything else
# for none. The orchestrator owns the in-process memory store; these tools
# proxy to it.
MEMORY_TOOLS_MODE = os.environ.get("VERSO_MEMORY_TOOLS", "").strip().lower()

mcp = FastMCP(
    SERVER_NAME,
    instructions=(
        "verso app bridge. Use search_toolkits to find the right app first when needed, "
        "then request_connection/list_connections/get_connection_status for auth and connection state. "
        "For Composio-backed app actions, use the native verso connected-app "
        "tools that Hermes exposes from this server. If the right native tool is not "
        "visible, use Hermes native tool search/describe/call to discover it.\n\n"
        "Connection management for ALL apps goes through verso, not Composio. "
        "If tool discovery or execution reports that no active connection exists, "
        "call verso.request_connection({toolkit: <slug>}) instead. After it "
        "returns, tell the user to use the verso connection card that appears "
        "in chat — never paste the raw authentication URL into the "
        "conversation.\n\n"
        "Use search_toolkits only to resolve an ambiguous app name to a "
        "Composio toolkit slug, and get_connection_status to poll an "
        "in-flight connection request."
    ),
)


@mcp.tool()
def request_connection(toolkit: str, reason: str | None = None) -> types.CallToolResult:
    """Start a user-facing connection flow for a service like Gmail or Slack.

    Use this whenever you need authentication for a Composio toolkit — either
    because the user explicitly asked to connect a service, or because a
    Composio tool returned a status_message asking for COMPOSIO_MANAGE_CONNECTIONS.
    The toolkit input can be an exact Composio slug like "googlecalendar" or a
    human name like "Google Calendar" when it resolves unambiguously.
    After calling this tool, tell the user to use the verso connection card.
    Do not paste authentication URLs into the chat.
    Returns structured connection request data including the request id, current
    status, and enough metadata for verso to render a connect button.
    """

    del reason
    toolkit_query = toolkit.strip()

    try:
        payload = _request(
            "POST",
            "/connections/request",
            {"toolkit": toolkit_query},
        )
        request = _sanitize_connection_request(payload["request"])
        return _structured_result(
            {
                "kind": "connection_request",
                "request": request,
            }
        )
    except Exception as exc:  # noqa: BLE001
        return _structured_result(
            {
                "kind": "connection_request",
                "request": {
                    "id": f"local-{toolkit_query.lower().replace(' ', '-')}",
                    "toolkitSlug": toolkit_query.strip().lower(),
                    "toolkitName": _toolkit_title(toolkit_query),
                    "logoUrl": None,
                    "status": "failed",
                    "redirectUrl": None,
                    "connectedAccountId": None,
                    "errorMessage": str(exc),
                },
            }
        )


@mcp.tool()
def search_toolkits(query: str, limit: int | None = None) -> types.CallToolResult:
    """Search Composio app/toolkit catalog by human name or use case.

    Use this when the user wants to connect an app but the exact toolkit slug is
    unknown. Results include whether the current user already has that toolkit
    connected.
    """

    payload = _request(
        "GET",
        _with_query("/connections/toolkits", {
            "query": query,
            **({"limit": limit} if isinstance(limit, int) else {}),
        }),
    )
    return _structured_result(payload)


@mcp.tool()
def list_connections() -> types.CallToolResult:
    """List catalog app and custom MCP connections with their current status."""

    payload = _request("GET", "/connections")
    if isinstance(payload, dict):
        try:
            custom = _request("GET", "/connectors/custom")
            connectors = custom.get("connectors") if isinstance(custom, dict) else None
        except Exception:
            connectors = None
        if isinstance(connectors, list):
            payload["custom_connectors"] = [
                {
                    "name": c.get("name"),
                    "slug": c.get("slug"),
                    "url": c.get("url"),
                    "status": (c.get("status") or {}).get("state"),
                    "tool_count": (c.get("status") or {}).get("toolCount"),
                    "tools_prefix": f"mcp__custom_{c.get('slug')}__",
                }
                for c in connectors
                if isinstance(c, dict)
            ]
    return _structured_result(payload)


@mcp.tool()
def get_connection_status(request_id: str) -> types.CallToolResult:
    """Get the latest status for a previously created connection request."""

    payload = _request("GET", f"/connections/requests/{urllib.parse.quote(request_id)}")
    return _structured_result(payload)


@mcp.tool()
def propose_message_draft(
    channel: Literal["gmail", "slack"],
    body: str,
    to: str | None = None,
    subject: str | None = None,
    cc: str | None = None,
    threadId: str | None = None,
    channel_label: str | None = None,
    channel_logo_url: str | None = None,
    to_display: str | None = None,
    to_avatar_url: str | None = None,
) -> types.CallToolResult:
    """Surface a Gmail email or Slack message for review before sending.

    Use this only for outbound Gmail email and Slack messages. Never use it
    for Notion pages or tables, documents, databases, tasks, calendar events,
    comments, or any other connected-app action.

    For Slack, `to="me"` sends to the authenticated user's own DM. For other
    direct messages, resolve the recipient with SLACK_FIND_USERS and open the
    conversation with SLACK_OPEN_DM, then pass the returned D-prefixed channel
    id as `to`. Public channel names and C/G-prefixed conversation ids are also
    accepted. Use `to_display` for the friendly name shown in the review UI.

    Verso handles the final send (or discard) from the review widget. After a
    "pending_review" result, do not call the underlying send tool yourself.
    """

    arguments: dict[str, Any] = {
        "channel": channel,
        "body": body,
    }
    optional_values = {
        "to": to,
        "subject": subject,
        "cc": cc,
        "threadId": threadId,
        "channel_label": channel_label,
        "channel_logo_url": channel_logo_url,
        "to_display": to_display,
        "to_avatar_url": to_avatar_url,
    }
    for key, value in optional_values.items():
        if isinstance(value, str) and value.strip():
            arguments[key] = value

    payload = _request(
        "POST",
        "/composio/tools/execute",
        {
            "toolSlug": "PROPOSE_MESSAGE_DRAFT",
            "arguments": arguments,
        },
    )
    return _structured_result(payload)


class _ManifestToolArgs(ArgModelBase):
    """Pass arbitrary MCP arguments through to the mapped Composio tool."""

    _payload: dict[str, Any] = {}

    @classmethod
    def model_validate(cls, obj: Any) -> "_ManifestToolArgs":  # type: ignore[override]
        inst = cls()
        inst._payload = obj if isinstance(obj, dict) else {}
        return inst

    def model_dump_one_level(self) -> dict[str, Any]:
        return {"arguments": self._payload}


def _register_manifest_tools() -> None:
    for item in _read_manifest_tools():
        native_name = item["nativeName"]
        tool_slug = item["toolSlug"]
        description = item["description"] or item["name"] or tool_slug
        input_schema = _normalize_input_schema(item["inputParameters"])

        def _handler(arguments: dict[str, Any], _tool_slug: str = tool_slug) -> types.CallToolResult:
            payload = _request(
                "POST",
                "/composio/tools/execute",
                {
                    "toolSlug": _tool_slug,
                    "arguments": arguments,
                },
            )
            return _structured_result(payload)

        # FastMCP's public add_tool() derives JSON Schema from a Python
        # signature. Composio already gives us the exact JSON Schema, so we
        # insert a Tool directly while still using FastMCP's normal list/call
        # machinery.
        mcp._tool_manager._tools[native_name] = Tool(  # noqa: SLF001
            fn=_handler,
            name=native_name,
            description=description,
            parameters=input_schema,
            fn_metadata=FuncMetadata(arg_model=_ManifestToolArgs),
            is_async=False,
        )


def _read_manifest_tools() -> list[dict[str, Any]]:
    if not COMPOSIO_TOOLS_MANIFEST:
        return []
    try:
        path = Path(COMPOSIO_TOOLS_MANIFEST)
        if not path.exists():
            return []
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []

    if not isinstance(parsed, dict) or parsed.get("version") != 1:
        return []
    raw_tools = parsed.get("tools")
    if not isinstance(raw_tools, list):
        return []

    tools: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in raw_tools:
        if not isinstance(raw, dict):
            continue
        native_name = raw.get("nativeName")
        tool_slug = raw.get("toolSlug")
        toolkit_slug = raw.get("toolkitSlug")
        input_parameters = raw.get("inputParameters")
        if (
            not isinstance(native_name, str)
            or not native_name
            or native_name in seen
            or not isinstance(tool_slug, str)
            or not tool_slug
            or not isinstance(toolkit_slug, str)
            or not toolkit_slug
            or not isinstance(input_parameters, dict)
        ):
            continue
        seen.add(native_name)
        tools.append(
            {
                "nativeName": native_name,
                "toolSlug": tool_slug,
                "toolkitSlug": toolkit_slug,
                "name": raw.get("name") if isinstance(raw.get("name"), str) else tool_slug,
                "description": raw.get("description") if isinstance(raw.get("description"), str) else None,
                "inputParameters": input_parameters,
            }
        )
    return tools


def _normalize_input_schema(schema: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(schema)
    if not isinstance(normalized.get("type"), str):
        normalized["type"] = "object"
    if not isinstance(normalized.get("properties"), dict):
        normalized["properties"] = {}
    required = normalized.get("required")
    if not isinstance(required, list):
        normalized["required"] = []
    return normalized


def _request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    if not ORCHESTRATOR_BASE_URL:
        raise RuntimeError("VERSO_ORCHESTRATOR_BASE_URL is not set")

    headers = {"Content-Type": "application/json"}
    if SIDECAR_AUTH_SECRET:
        headers["X-Verso-Sidecar-Token"] = SIDECAR_AUTH_SECRET

    request = urllib.request.Request(
        f"{ORCHESTRATOR_BASE_URL}{path}",
        method=method,
        headers=headers,
    )

    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    try:
        with urllib.request.urlopen(request, data=data, timeout=30) as response:
            raw = response.read().decode("utf-8")
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
            raise RuntimeError(f"Unexpected response payload for {path}")
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace").strip()
        return _http_error_payload(exc.code, details, path)
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Failed to reach verso orchestrator at {ORCHESTRATOR_BASE_URL}") from exc


def _structured_result(payload: dict[str, Any]) -> types.CallToolResult:
    text = json.dumps(payload, ensure_ascii=True)
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=text)],
        structuredContent=payload,
    )


def _http_error_payload(status: int, details: str, path: str) -> dict[str, Any]:
    parsed: dict[str, Any] = {}
    if details:
        try:
            raw = json.loads(details)
            if isinstance(raw, dict):
                parsed = raw
        except json.JSONDecodeError:
            parsed = {}

    message = parsed.get("message") if isinstance(parsed.get("message"), str) else None
    error = parsed.get("error") if isinstance(parsed.get("error"), str) else "request_failed"
    return {
        "ok": False,
        "error": error,
        "status": status,
        "message": message or details or f"HTTP {status} while calling {path}",
    }


def _toolkit_title(toolkit_slug: str) -> str:
    normalized = toolkit_slug.strip().lower()
    if normalized == "gmail":
        return "Gmail"
    return toolkit_slug.replace("_", " ").replace("-", " ").title()


def _with_query(path: str, params: dict[str, Any]) -> str:
    query = urllib.parse.urlencode({
        key: value for key, value in params.items()
        if value is not None and str(value).strip() != ""
    })
    return f"{path}?{query}" if query else path


def _sanitize_connection_request(request: dict[str, Any]) -> dict[str, Any]:
    sanitized = dict(request)
    sanitized["redirectUrl"] = None
    return sanitized


def search_memory(query: str, limit: int | None = None) -> types.CallToolResult:
    """Search your persistent memory about this user.

    The memory holds curated memory pages you have written yourself AND raw
    history from past conversations and the user's connected apps (email,
    Slack, meeting notes): people, companies, projects, deals, decisions,
    preferences, and commitments. Use it before web search whenever the
    answer may involve anything the user has talked about before. Returns
    matching entries with slugs, scores, and snippets; fetch full entries
    with get_memory_page. If wording might differ, retry with a reworded
    query before concluding nothing is stored.
    """

    body: dict[str, Any] = {"query": query}
    if isinstance(limit, int):
        body["limit"] = limit
    return _structured_result(_request("POST", "/memory/search", body))


def get_memory_page(slug: str) -> types.CallToolResult:
    """Read one full memory entry by slug, as returned by search_memory.

    Works on curated page slugs (people/jane-doe) and raw document results
    (doc:<id>) alike.
    """

    return _structured_result(_request("POST", "/memory/page", {"slug": slug}))


def write_memory_page(slug: str, content: str) -> types.CallToolResult:
    """Create or update a persistent memory page about a person, project,
    preference, decision, or fact worth remembering across conversations.

    Search first; update the existing page instead of creating a
    near-duplicate. Slug: short-kebab-case, e.g. people/jane-doe,
    companies/acme, projects/atlas. Content is full markdown.
    """

    return _structured_result(
        _request("POST", "/memory/write-page", {"slug": slug, "content": content})
    )


def _register_memory_tools() -> None:
    if MEMORY_TOOLS_MODE != "full":
        return
    mcp.tool()(search_memory)
    mcp.tool()(get_memory_page)
    mcp.tool()(write_memory_page)


async def _run_stdio_async() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await mcp._mcp_server.run(  # noqa: SLF001
            read_stream,
            write_stream,
            mcp._mcp_server.create_initialization_options(),
        )


def main() -> None:
    _register_manifest_tools()
    _register_memory_tools()
    anyio.run(_run_stdio_async)


if __name__ == "__main__":
    main()
