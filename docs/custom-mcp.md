# Custom MCP connections

In Verso’s connections catalog, choose **Add a custom connector** and enter
the server’s name and URL. Leave the API token empty for browser sign-in.

For providers that require you to register your own OAuth client, expand
**OAuth settings (optional)**. Copy the displayed redirect URL into the
provider’s OAuth app, then enter its client ID and client secret in Verso.
Leave the secret empty only if the provider does not require one.

## HubSpot

1. In Verso, add a custom connector named **HubSpot** with URL
   `https://mcp.hubspot.com` and expand **OAuth settings (optional)**.
2. Copy the redirect URL: `http://localhost:43821/oauth/callback`.
3. In HubSpot, go to **Development → MCP Connectors → Create MCP connector**.
   Register the copied URL as its redirect URL.
4. Copy the generated client ID and client secret into Verso, then click
   **Connect** and approve access in your browser.
5. Return to Verso and confirm the connector shows as connected. Ask Verso
   to check your HubSpot user details to verify access.

See [HubSpot’s official setup instructions](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server).
If you previously added HubSpot without OAuth credentials, disconnect that
entry and add it again using these settings.

## How the callback works

All manually registered OAuth connectors share the same redirect URL. The
browser returns to Verso on your Mac; the temporary OAuth `state` identifies
the pending connection. Verso relays the callback to Hermes, which validates
the state and handles PKCE, token exchange, and refresh.

Verso must be running on the same Mac as the browser. The callback listener
binds only to the IPv4 and IPv6 loopback addresses during sign-in. Its port
stays fixed across app launches. If another app or Verso instance has that
port open, sign-in reports an error; close that instance and retry. The URL
does not need a public server or a tunnel.

Verso stores the client secret in macOS Keychain and passes it to Hermes via
an environment reference, keeping it out of connector JSON, managed YAML,
and connector API responses. Hermes maintains its existing local OAuth
credential cache, including registered client information and tokens.
Disconnecting removes the Keychain entry and that connector’s OAuth cache.

Servers with automatic OAuth registration continue to use the existing
sign-in flow and do not require these settings.

## Interrupted connections

The connection indicator reflects the gateway's live MCP session and tools,
not merely the presence of saved credentials. Verso checks established custom
connections every 15 seconds. If a session drops, the sidebar reports the
interruption while Hermes retries. Successful recovery restores the connected
indicator automatically; OAuth requests release their authentication gate even
when a network error or cancellation interrupts them.
