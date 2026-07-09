# Examples

Each file is a Node-RED flow export built from `mcp-in`/`mcp-out` nodes, its own dedicated
`mcp-server` config node, plus plain `function`/`http request` nodes — no dependency on any
other custom module.

| File | Integration | Default path |
|---|---|---|
| `jellyfin-mcp.json` | Jellyfin media server search + poster art | `/mcp/jellyfin` |
| `calibre-mcp.json` | Calibre-Web ebook library | `/mcp/calibre` |
| `docker-mcp.json` | Docker container list/start/stop/restart/logs | `/mcp/docker` |
| `music-mcp.json` | Music Assistant playback control | `/mcp/music` |
| `radarr-mcp.json` | Radarr movie search/lookup | `/mcp/radarr` |
| `rest980-mcp.json` | iRobot Roomba control (via rest980) | `/mcp/roomba` |
| `seerr-mcp.json` | Overseerr media requests | `/mcp/seerr` |
| `sonarr-mcp.json` | Sonarr TV series/episodes | `/mcp/sonarr` |
| `spotify-mcp.json` | Spotify playback + search (includes an OAuth callback flow) | `/mcp/spotify` |

Each `mcp-server` node already carries a server-level **Instructions** description of what
that integration does — it's what an MCP client sees before it even lists tools, distinct
from the per-tool descriptions on each `mcp-in` node.

## Importing

1. In the Node-RED editor: **Menu → Import**, paste or select the file.
2. Open the flow's `mcp-server` config node (double-click any `mcp-in`/`mcp-out` node and
   click the pencil next to **MCP Server**, or find it under the palette's config-node list).
   `path` and the server-level description are already filled in; **Server URL** and
   **Identity provider** are intentionally left blank and marked required — fill those in
   with your own deployment's public URL and OIDC issuer before deploying (see the main
   [README](../README.md#reverse-proxy) for what your reverse proxy needs to expose).
3. Fill in any integration-specific credentials/URLs used by the `function`/`http request`
   nodes in the flow (these are unrelated to MCP auth and specific to each backend service).
4. Deploy, then point an MCP client at `https://<serverUrl>/mcp/<path>`.

Each example's `mcp-server` node is independent — importing several examples into the same
Node-RED instance is safe and gives each integration its own path, auth configuration, and
enable/disable switch.
