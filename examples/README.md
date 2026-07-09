# Examples

Each file is a Node-RED flow export built entirely from `mcp-in`/`mcp-out` nodes plus
plain `function`/`http request` nodes — no dependency on any other custom module.

| File | Integration |
|---|---|
| `jellyfin-mcp.json` | Jellyfin media server search + poster art |
| `calibre-mcp.json` | Calibre-Web ebook library |
| `docker-mcp.json` | Docker container list/start/stop/restart/logs |
| `music-mcp.json` | Music Assistant playback control |
| `radarr-mcp.json` | Radarr movie search/lookup |
| `rest980-mcp.json` | iRobot Roomba control (via rest980) |
| `seerr-mcp.json` | Overseerr media requests |
| `sonarr-mcp.json` | Sonarr TV series/episodes |
| `spotify-mcp.json` | Spotify playback + search (includes an OAuth callback flow) |

## Importing

1. In the Node-RED editor: **Menu → Import**, paste or select the file.
2. None of these flows embed an `mcp-server` config node — after import, add one
   (or reuse an existing one) and point every `mcp-in`/`mcp-out` node's **MCP Server**
   field at it. Each example is self-contained and works well as its own `mcp-server`
   instance (its own `/mcp/<path>`), so different integrations can be enabled/disabled
   and re-authenticated independently.
3. Fill in any integration-specific credentials/URLs used by the `function`/`http request`
   nodes in the flow (these are unrelated to MCP auth and specific to each backend service).
4. Deploy, then point an MCP client at `https://<serverUrl>/mcp/<path>`.
