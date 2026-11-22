# chat-demo (self-hosted)

English | [简体中文](README.zh-CN.md)

A DeepSeek chat UI with a small, dependency-free backend. The backend:

- serves the built frontend;
- keeps the DeepSeek API Key on the server, so browsers never see it;
- proxies chat, file-upload and speech requests to DeepSeek;
- stores conversations and original attachments on the server, shared by every browser and device;
- reads and displays the account balance.

Enter the API key once and it works everywhere; chat history is no longer tied to a single browser.

## Quick start

Building the frontend requires Node.js 22.12+ and pnpm. The backend only needs Node.js 18.17+.

```sh
pnpm install
pnpm build
pnpm start
```

Open `http://<server-ip>:8090` and enter the API key once when prompted. It is then stored on the server.

To accept local connections only:

```sh
HOST=127.0.0.1 pnpm start
```

## Environment variables

| Variable           | Default                    | Description                                                 |
| ------------------ | -------------------------- | ----------------------------------------------------------- |
| `PORT`             | `8090`                     | Listen port                                                 |
| `HOST`             | `0.0.0.0`                  | Listen address; use `127.0.0.1` for local-only access       |
| `DATA_DIR`         | `<project>/data`           | Data directory for the key, sessions and attachments        |
| `DEEPSEEK_ORIGIN`  | `https://api.deepseek.com` | DeepSeek API origin; can point at a compatible gateway      |
| `DEEPSEEK_API_KEY` | empty                      | Optional; when set it overrides the key saved from the page |

For example, keep data on a separate disk and run in the background:

```sh
DATA_DIR=/var/lib/chat-demo HOST=0.0.0.0 PORT=8090 pnpm start
# or manage it with systemd / pm2 / tmux / nohup
```

## Development

Run the backend and the dev server separately (UI on 8090, backend on 8787, `/api` proxied by the dev server):

```sh
# terminal 1
PORT=8787 pnpm server

# terminal 2
pnpm dev
```

Open http://localhost:8090. On Windows PowerShell, set environment variables with `$env:PORT=8787`.

## Data and backups

```text
data/
  config.json          API key stored on the server (mode 0600, never served to browsers)
  sessions/<id>.json   one JSON file per conversation
  files/<id>.bin       original attachments; <id>.type stores the MIME type
  staging/             temporary area for history import; replaces live data atomically
```

- Backup: stop the server and copy the whole `data/` directory; restore it before starting again.
- Upgrade: replace the code, run `pnpm install && pnpm build`, then restart. `data/` is untouched.
- `data/` is git-ignored; never commit it or expose it as static content.

## API key, balance and sharing

- When you enter a key, the server validates it with `GET /models` and then writes it to `data/config.json`. The browser only keeps a masked hint such as `sk-********abcd`.
- With `DEEPSEEK_API_KEY` set, the key is read-only in the UI and the page cannot override the environment variable.
- The old version kept the key in browser localStorage. On the first launch after upgrading, it is migrated to the server and removed from the browser automatically.
- The balance appears at the bottom of the sidebar: click to refresh, and it refreshes automatically after each reply and when the page regains focus. Hover to see granted and topped-up amounts.
- Multiple browsers: the conversation list is refreshed when the page becomes visible, so chats created on another device show up. If the same chat is edited in two places, the last save wins (single-user design, no conflict merging).

## Security notes (important)

This build assumes the server is yours alone and has **no login**. Anyone who can reach the port can chat with your key, spend your balance, and read or delete all history.

Do at least one of the following:

- allow only your own IP in the cloud firewall / security group;
- listen on `127.0.0.1` only and use an SSH tunnel: `ssh -L 8090:127.0.0.1:8090 user@server`;
- put nginx / Caddy with Basic Auth and HTTPS in front of it.

Do not share the public address with others. When using nginx, disable response buffering so streamed replies are not buffered:

```nginx
location / {
    proxy_pass http://127.0.0.1:8090;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    client_max_body_size 100m;
}
```

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- API key and chat history stored on the server and shared across browsers and devices, with the account balance displayed.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## History import and export

Data management in Settings uses ZIP archives.

- Import: the archive format and version are checked first, then written to the server's staging area. Only after everything succeeds does it atomically replace all conversations and attachments on the server; failures keep the previous data.
- Export: includes all conversations and the images available on the server; other attachments keep only their metadata; API keys and settings are excluded.
- Delete all chats: clears every conversation, original attachment and unsent draft on the server. The API key and other settings are kept; files already uploaded to DeepSeek are not deleted.

See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

## Project layout

```text
server/
  index.mjs            dependency-free backend: static files + API proxy + storage + balance
src/
  app/                 application layout, themes, and global styles
  components/          chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               DeepSeek requests, SSE and protocol types (through /api/deepseek)
    chat/              conversations, branches, server storage, history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            audio recording and read-aloud playback
  utils/               shared utilities
```

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
