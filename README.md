# OpenProxyRouter — The Open-Source AI Protocol Router

<p align="center">
  <em>A minimal-dependency local HTTPS gateway that bidirectionally translates between the OpenAI and Anthropic protocols, routes by model name, and lets any client talk to any backend without code changes.</em>
</p>

<p align="center">
  <em><strong>OpenProxyRouter</strong> is what it says on the box: an open-source router that proxies AI protocol requests. Think of it as a universal adapter — OpenAI clients call Anthropic backends, Anthropic clients call OpenAI backends, all through a single local endpoint. No SDK rewrites, no vendor lock-in, just routes.</em>
</p>

<p align="center">
  <a href="./README.zh.md">中文</a> ·
  <a href="./README.md"><strong>English</strong></a>
</p>

<p align="center">
  <a href="#overview">Overview</a> ·
  <a href="#highlights">Highlights</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#bi-directional-protocol-conversion">Protocol Conversion</a> ·
  <a href="#client-integration">Clients</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#configuration">Config</a> ·
  <a href="#api">API</a> ·
  <a href="#logging--debugging">Logs</a> ·
  <a href="#troubleshooting">Troubleshoot</a> ·
  <a href="#security">Security</a> ·
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-green.svg">
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg">
  <img alt="zero-deps" src="https://img.shields.io/badge/runtime%20deps-1%20(undici)-success.svg">
  <img alt="status" src="https://img.shields.io/badge/status-stable-brightgreen.svg">
</p>

---

## Overview

You have an API key from some vendor. You have a favorite client — Codex, Claude Code Desktop, Cursor, whatever ships next quarter. The vendor and the client speak different protocols. Normally you'd swap SDKs, rewrite glue, or wait for the client to add support.

**OpenProxyRouter gives up on waiting.** Point any OpenAI-speaking or Anthropic-speaking client at `https://127.0.0.1:8443/anthropic`, and the gateway figures out — based on the `model` name in the request — which backend to call and which protocol to translate to. Streaming, tool calls, images, thinking, usage: all preserved.

- **OpenAI clients** (Cursor, LangChain, Aider, Continue.dev, …) can call **Claude / Anthropic models** directly
- **Anthropic clients** (Claude Code Desktop, anthropic SDK) can call **GPT / DeepSeek / Qwen / GLM / Moonshot** or any OpenAI-compatible model
- One address, one config file, automatic routing by `model` name

In short: **your client code never changes. Switch models by changing one string.**

```
         ╔════════════════════════════════════════════════════════════╗
         ║                   OpenProxyRouter                         ║
         ║                                                            ║
   OpenAI ├─► /v1/chat/completions  ─►  ┌─ Anthropic backend (convert) ┤
   client │                             │                              │
         │                             └─ OpenAI backend    (passthrough)
         ║                                                            ║
  Anthropic├─► /v1/messages          ─►  ┌─ Anthropic backend (passthrough)
   client │                             │                              │
         │                             └─ OpenAI backend    (convert) ─┤
         ╚════════════════════════════════════════════════════════════╝
            Client protocol                 Backend protocol
           (what you want)              (what you configured)
```

## Highlights

- **Protocol agnostic**: OpenAI SDK / Anthropic SDK / Claude Code Desktop / curl / LangChain / LiteLLM / Cursor / Continue.dev all work
- **Model agnostic**: Claude, GPT, DeepSeek, Qwen, Moonshot, GLM, Ollama, etc., unified entrypoint
- **Path agnostic**: Same gateway listens on both `/v1/messages` and `/v1/chat/completions`
- **Minimal dependencies**: `undici` for HTTP + `better-sqlite3` for persistent token storage — single `npm install`
- **Modular codebase**: Cleanly split into `src/` modules (config, logger, metrics, converters, handlers, etc.)
- **Full conversion**: Streaming SSE, tool calls, images, system prompts, usage — all preserved across protocols
- **Local HTTPS**: mkcert + Caddy, system-trusted certificates
- **Process supervision**: Built-in health checks, auto-restart, graceful shutdown (30s drain)
- **Observability**: Structured logs (TTY-color / JSON-piped) + Metrics endpoint (P50/P95/P99, token stats)
- **Usage Dashboard**: Built-in web UI at `/_dashboard` — per-model token totals, cache hits, TTFT, ITL, QPS, token/s, with Chart.js visualization and time-range filtering
- **Persistent storage**: SQLite (WAL mode, batched writes) with 365-day retention — survives restarts
- **Accurate token capture**: Captures usage from all 8 client-backend path combinations (streaming and non-streaming, passthrough and converted) via the API response data
- **Thinking adaptation**: Auto-normalize `thinking.enabled` to AWS Bedrock-compatible `adaptive`
- **Tested**: 115 unit tests covering converters, thinking, metrics, token estimation, usage recording, SSE parsing, and circuit breaker

## Quick Start

> From "I have an API key" to "every client on this machine can talk to every model." The supervisor in `start.sh` takes care of the rest.

### 1. Install system dependencies

**macOS**

```bash
brew install node caddy mkcert
```

**Linux (Debian / Ubuntu)**

```bash
# Node.js >= 18
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# mkcert
sudo apt install -y libnss3-tools
curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64"
chmod +x mkcert-v*-linux-amd64 && sudo mv mkcert-v*-linux-amd64 /usr/local/bin/mkcert
```

**Arch Linux**

```bash
sudo pacman -S nodejs npm caddy mkcert
```

**Windows**: Use WSL2 and follow Linux instructions. Native Windows is untested.

Version requirements: Node.js >= 18 / Caddy >= 2.6 / mkcert >= 1.4.

### 2. Clone the project

```bash
git clone https://github.com/xq25478/OpenProxyRouter.git
cd OpenProxyRouter
```

### 3. Install Node dependencies

```bash
npm install
```

Dependencies: [`undici`](https://github.com/nodejs/undici) (HTTP client) + [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) (sync SQLite, token persistence). If `better-sqlite3` fails to compile, the gateway runs fine without persistent storage.

### 4. Configure backends

Create `backends.json` in the project root. Each entry describes one upstream provider:

| Field     | Required | Description                                                                                  |
| --------- | -------- | -------------------------------------------------------------------------------------------- |
| `type`    | yes      | `"anthropic"` or `"openai"` — selects which protocol the gateway speaks to this backend.     |
| `name`    | no       | Free-form label, shown in logs and the startup banner.                                       |
| `baseUrl` | yes      | Upstream endpoint. Anthropic-compatible: ends at `/anthropic` or root. OpenAI-compatible: ends at `/v1`. |
| `apiKey`  | yes      | Real upstream API key. Use `"EMPTY"` if upstream requires no auth.                           |
| `models`  | yes      | List of model IDs this backend serves. Routing is by exact match on the request `model` field; IDs must be unique across all backends. |

Example `backends.json`:

```json
[
  {
    "type": "anthropic",
    "name": "Anthropic Official",
    "baseUrl": "https://api.anthropic.com",
    "apiKey": "sk-ant-...",
    "models": ["Claude-Opus-4.7", "claude-3-5-sonnet-20241022"]
  },
  {
    "type": "openai",
    "name": "OpenAI",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "models": ["gpt-4o", "gpt-4o-mini"]
  },
  {
    "type": "openai",
    "name": "DeepSeek",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-...",
    "models": ["DeepSeek-V4-Pro"]
  }
]
```

> `backends.json` is gitignored — never commit it.

### 5. Launch

```bash
bash start.sh
```

`start.sh` will automatically:
- Check system deps (node / caddy / mkcert / curl / lsof)
- Generate an mkcert local TLS certificate
- Write the Caddyfile
- Start the Node gateway (`127.0.0.1:8787`) and Caddy HTTPS reverse proxy (`127.0.0.1:8443`)
- Enter supervisor loop (auto-restart on crash)

### 6. Verify

You should see:

```
Gateway base URL:
  https://127.0.0.1:8443/anthropic

Models (5 total):
  - Claude-Opus-4.7
  - gpt-4o
  - DeepSeek-V4-Pro
  - ...
```

Visit `https://127.0.0.1:8443/anthropic/v1/models` in a browser — you should get a JSON model list (you may need to trust the mkcert cert on first visit).

### 7. Stop / Restart / Uninstall

- **Stop**: Press `Ctrl+C` in the `start.sh` foreground terminal. The gateway has a 30s SIGTERM drain window so in-flight requests complete.
- **Restart**: The script has built-in supervision — Caddy/Node crashes are restarted within 5s. To restart manually, just run `bash start.sh` again; old processes and ports are cleaned up.
- **Background**:
  ```bash
  nohup bash start.sh > gateway.log 2>&1 &
  ```
- **Uninstall completely**:
  ```bash
  # Kill running processes
  lsof -nP -iTCP:8787 -sTCP:LISTEN -t | xargs -r kill
  lsof -nP -iTCP:8443 -sTCP:LISTEN -t | xargs -r kill

  # Remove certs
  rm -rf ~/.certs/claude-proxy
  # Remove mkcert root CA from system trust store (caution: affects other mkcert-issued certs)
  mkcert -uninstall

  # Delete the repo
  rm -rf /path/to/OpenProxyRouter
  ```

## Bi-directional Protocol Conversion

This is the project's **core capability**. The four combinations:

| Client protocol | Backend type | Handling | Typical use |
|:---------:|:---------:|:--------:|:--------|
| **OpenAI** `/v1/chat/completions` | `anthropic` | **Convert** | OpenAI SDK → Claude |
| **OpenAI** `/v1/chat/completions` | `openai` | Passthrough | OpenAI SDK → GPT / DeepSeek |
| **Anthropic** `/v1/messages` | `anthropic` | Passthrough | Claude Code Desktop → Claude |
| **Anthropic** `/v1/messages` | `openai` | **Convert** | Claude Code Desktop → GPT |

Conversion coverage:

| Feature | OpenAI → Anthropic | Anthropic → OpenAI |
|------|:------------------:|:------------------:|
| Basic chat | ✅ | ✅ |
| System prompt | ✅ | ✅ |
| Streaming SSE (token-by-token) | ✅ | ✅ |
| Tool calls / function calling | ✅ | ✅ |
| Multi-turn tool_result | ✅ | ✅ |
| Image input (base64 / URL) | ✅ | - |
| Stop sequences | ✅ | ✅ |
| Temperature / top_p | ✅ | ✅ |
| Usage stats (incl. cache tokens) | ✅ | ✅ |
| finish_reason ↔ stop_reason | ✅ | ✅ |
| Thinking normalization | ✅ | ✅ |

## Client Integration

### OpenAI Python SDK (recommended)

One configuration, call any model:

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://127.0.0.1:8443/anthropic/v1",
    api_key="any-string",                    # real apiKey lives in backends.json
)

# Call Claude (auto protocol conversion)
resp = client.chat.completions.create(
    model="Claude-Opus-4.7",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)

# Same code calls GPT (passthrough)
resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}],
)

# Same code calls DeepSeek
resp = client.chat.completions.create(
    model="DeepSeek-V4-Pro",
    messages=[{"role": "user", "content": "Hello"}],
)

# Streaming works identically
for chunk in client.chat.completions.create(
    model="Claude-Opus-4.7",
    messages=[{"role": "user", "content": "Write a poem"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")

# Function calling works identically
resp = client.chat.completions.create(
    model="Claude-Opus-4.7",
    messages=[{"role": "user", "content": "Weather in Beijing"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "get_weather",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
        },
    }],
)
```

**TLS trust**: Run `mkcert -install` first to trust the local root CA. If Python still complains about certificates:

```bash
export SSL_CERT_FILE=$(mkcert -CAROOT)/rootCA.pem
export REQUESTS_CA_BUNDLE=$(mkcert -CAROOT)/rootCA.pem
```

### OpenAI Node.js SDK

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://127.0.0.1:8443/anthropic/v1",
  apiKey: "any-string",
});

const resp = await client.chat.completions.create({
  model: "Claude-Opus-4.7",
  messages: [{ role: "user", content: "Hello" }],
});
```

### Anthropic Python SDK

```python
import anthropic

client = anthropic.Anthropic(
    base_url="https://127.0.0.1:8443/anthropic",
    api_key="any-string",
)

# Call Claude (passthrough)
resp = client.messages.create(
    model="Claude-Opus-4.7",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)

# Call GPT (auto protocol conversion)
resp = client.messages.create(
    model="gpt-4o",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
```

### Claude Code Desktop

In Settings → Gateway:

| Field | Value |
|--------|-----|
| Gateway base URL | `https://127.0.0.1:8443/anthropic` |
| Gateway API key | any string (or empty) |
| Gateway auth scheme | `bearer` |

All configured models appear in the model dropdown, including GPT / DeepSeek etc.

### curl quick test (all 4 combinations)

```bash
# 1. OpenAI protocol → Anthropic backend (convert)
curl -k https://127.0.0.1:8443/anthropic/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Claude-Opus-4.7","messages":[{"role":"user","content":"hi"}]}'

# 2. OpenAI protocol → OpenAI backend (passthrough)
curl -k https://127.0.0.1:8443/anthropic/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'

# 3. Anthropic protocol → Anthropic backend (passthrough)
curl -k https://127.0.0.1:8443/anthropic/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"Claude-Opus-4.7","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'

# 4. Anthropic protocol → OpenAI backend (convert)
curl -k https://127.0.0.1:8443/anthropic/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"gpt-4o","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```

### Other OpenAI-compatible tools

All of these work out of the box (set base URL to `https://127.0.0.1:8443/anthropic/v1`):

- **Cursor** / **Continue.dev** / **Zed AI** — use Claude as a coding assistant
- **LangChain** / **LlamaIndex** / **LiteLLM** — unified backends, switch models freely
- **Open WebUI** / **LibreChat** / **ChatGPT-Next-Web** / **LobeChat** — self-hosted chat UIs
- **Aider** / **Cline** / **Roo-Code** — CLI / IDE coding assistants
- **Dify** / **FastGPT** — LLM application platforms

<details>
<summary><strong>Cursor</strong></summary>

Settings → Models → OpenAI API Key: any string; OpenAI Base URL:
```
https://127.0.0.1:8443/anthropic/v1
```
Then add models like `Claude-Opus-4.7` in Model Override.
</details>

<details>
<summary><strong>Aider</strong></summary>

```bash
export OPENAI_API_BASE=https://127.0.0.1:8443/anthropic/v1
export OPENAI_API_KEY=any-string
export SSL_CERT_FILE=$(mkcert -CAROOT)/rootCA.pem

aider --model openai/Claude-Opus-4.7
```
</details>

<details>
<summary><strong>LiteLLM proxy</strong></summary>

```yaml
# config.yaml
model_list:
  - model_name: claude-opus
    litellm_params:
      model: openai/Claude-Opus-4.7
      api_base: https://127.0.0.1:8443/anthropic/v1
      api_key: any-string
```
</details>

<details>
<summary><strong>LangChain (Python)</strong></summary>

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="Claude-Opus-4.7",
    base_url="https://127.0.0.1:8443/anthropic/v1",
    api_key="any-string",
)
```
</details>

<details>
<summary><strong>Cline (VS Code extension)</strong></summary>

API Provider: "OpenAI Compatible":
- Base URL: `https://127.0.0.1:8443/anthropic/v1`
- API Key: any string
- Model ID: `Claude-Opus-4.7` or any model exposed by the gateway
</details>

<details>
<summary><strong>Open WebUI</strong></summary>

Settings → Connections → OpenAI API:
- API Base URL: `https://127.0.0.1:8443/anthropic/v1`
- API Key: any string
</details>

## Architecture

> Three layers: TLS termination, protocol routing, upstream forwarding. A router only ever needs three planks.

```
┌─────────────────────────────────────────────────────────────────┐
│  Client                                                         │
│  OpenAI SDK / Anthropic SDK / Claude Code Desktop / curl / ...  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS (mkcert-trusted cert)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Caddy :8443                                                    │
│  - TLS termination                                              │
│  - Reverse proxy to Node gateway                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP (127.0.0.1 only)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Node Gateway :8787 (index.js + src/ modules)                   │
│                                                                 │
│  1. Route dispatch: /v1/messages or /v1/chat/completions        │
│  2. Parse body.model, look up backend in modelIndex             │
│  3. Select handler by (client protocol, backend type):          │
│                                                                 │
│     proxyRequest            —— Anthropic → Anthropic (pass)     │
│     proxyOpenAIChat         —— Anthropic → OpenAI   (convert)   │
│     proxyOpenAIDirect       —— OpenAI    → OpenAI   (pass)      │
│     proxyAnthropicAsOpenAI  —— OpenAI    → Anthropic (convert)  │
│                                                                 │
│  4. Stream SSE in real time / buffer non-streaming              │
│  5. Error handling / Metrics / Logging                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP/HTTPS
                           ▼
                    Upstream APIs (mixed backends)
                Anthropic  OpenAI  DeepSeek  ...
```

## Configuration

### `backends.json`

```json
[
  {
    "type": "anthropic",
    "name": "Display name",
    "baseUrl": "https://api.anthropic.com",
    "apiKey": "sk-ant-...",
    "models": ["model-a", "model-b"]
  }
]
```

| Field | Type | Description |
|------|------|------|
| `type` | `"anthropic"` \| `"openai"` | Backend protocol type |
| `name` | string | Display name (logs only) |
| `baseUrl` | string | Backend base URL (OpenAI-compatible backends: `/v1` suffix optional) |
| `apiKey` | string | API Key; if empty, extracted from client's `Authorization: Bearer` header |
| `models` | string[] | Model names exposed by this backend, **must be globally unique** (clients route by this name) |

### Environment variables

| Variable | Default | Description |
|------|------|------|
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

### Ports

- `8787` Node gateway (127.0.0.1 only)
- `8443` Caddy HTTPS (127.0.0.1 only)

To change: edit `PORT` in `src/config.js` and `CADDY_PORT` in `start.sh`.

### More backend examples

Append any of these to your `backends.json` array:

<details>
<summary><strong>Azure OpenAI</strong></summary>

```json
{
  "type": "openai",
  "name": "Azure OpenAI",
  "baseUrl": "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT",
  "apiKey": "...",
  "models": ["gpt-4o-azure"]
}
```
Azure URLs need the deployment name and `?api-version=...` — append to `baseUrl`.
</details>

<details>
<summary><strong>OpenRouter</strong></summary>

```json
{
  "type": "openai",
  "name": "OpenRouter",
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "sk-or-...",
  "models": [
    "anthropic/claude-3.5-sonnet",
    "google/gemini-pro-1.5",
    "meta-llama/llama-3.1-70b-instruct"
  ]
}
```
</details>

<details>
<summary><strong>SiliconFlow</strong></summary>

```json
{
  "type": "openai",
  "name": "SiliconFlow",
  "baseUrl": "https://api.siliconflow.cn/v1",
  "apiKey": "sk-...",
  "models": [
    "deepseek-ai/DeepSeek-V3",
    "Qwen/Qwen2.5-72B-Instruct"
  ]
}
```
</details>

<details>
<summary><strong>Moonshot</strong></summary>

```json
{
  "type": "openai",
  "name": "Moonshot",
  "baseUrl": "https://api.moonshot.cn/v1",
  "apiKey": "sk-...",
  "models": ["moonshot-v1-128k", "moonshot-v1-32k"]
}
```
</details>

<details>
<summary><strong>Zhipu GLM</strong></summary>

```json
{
  "type": "openai",
  "name": "Zhipu",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "apiKey": "...",
  "models": ["glm-4", "glm-4-flash"]
}
```
</details>

<details>
<summary><strong>Qwen (DashScope compatible mode)</strong></summary>

```json
{
  "type": "openai",
  "name": "DashScope",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "apiKey": "sk-...",
  "models": ["qwen-max", "qwen-plus", "qwen-turbo"]
}
```
</details>

<details>
<summary><strong>Volcengine Ark / Doubao</strong></summary>

```json
{
  "type": "openai",
  "name": "Doubao",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
  "apiKey": "...",
  "models": ["doubao-pro-32k", "doubao-pro-128k"]
}
```
Doubao's `models` field takes **inference endpoint IDs** (e.g. `ep-xxx`) or actual model names.
</details>

<details>
<summary><strong>Local Ollama</strong></summary>

```json
{
  "type": "openai",
  "name": "Ollama",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "apiKey": "ollama",
  "models": ["llama3.1:70b", "qwen2.5:32b"]
}
```
</details>

> **⚠️ Reminder**: Names in the `models` array must be **globally unique** across all backends. Clients route by these names.

## API

All paths are prefixed with `/anthropic` (to coexist with other services behind the same Caddy).

### Anthropic protocol

| Method | Path | Description |
|------|------|------|
| `POST` | `/anthropic/v1/messages` | Messages API (streaming, tools, images) |
| `POST` | `/anthropic/v1/messages/count_tokens` | Token estimation (local) |

### OpenAI protocol

| Method | Path | Description |
|------|------|------|
| `POST` | `/anthropic/v1/chat/completions` | Chat Completions API |

### Model discovery

| Method | Path | Description |
|------|------|------|
| `GET` | `/anthropic/v1/models` | List all configured models |
| `GET` | `/anthropic/v1/models/{id}` | Query a single model |

### Ops

| Method | Path | Description |
|------|------|------|
| `GET` | `/anthropic/v1/metrics` | Request counts, latency percentiles, error counts, token stats |
| `GET` | `/` | Health check |
| `HEAD` | `/` | Health check (silent) |
| `GET` | `/dashboard` | Web-based token usage dashboard |
| `GET` | `/dashboard/api` | Dashboard JSON API (query params: `from`, `to` as epoch ms) |

### Metrics example

```bash
$ curl -sk https://127.0.0.1:8443/anthropic/v1/metrics | jq
{
  "requests": 1234,
  "status": { "2xx": 1200, "4xx": 20, "5xx": 14 },
  "upstream_errors": 8,
  "latency_p50": 420,
  "latency_p95": 2800,
  "latency_p99": 5100,
  "tokens": {
    "input": 50000,
    "output": 25000,
    "cache_read": 12000,
    "cache_write": 3000
  }
}
```

## Logging & Debugging

Logs go straight to the terminal. TTY mode renders with colored labels; pipe mode emits JSON (for `jq` / log collectors):

```
[08:35:45] system loaded 5 backends, 5 models
[08:35:45] system listening on http://127.0.0.1:8787
[08:35:46] recv 50eb2cce POST /anthropic/v1/chat/completions
[08:35:46] route 50eb2cce POST /anthropic/v1/chat/completions elapsed=1ms backend=OpenAI model=gpt-4o
[08:35:46] done 50eb2cce POST /anthropic/v1/chat/completions status=200 elapsed=491ms backend=OpenAI
```

Label glossary:

| Label | Meaning |
|---|---|
| `recv` | Request received |
| `route` | Routed to backend |
| `done` | Request completed |
| `error` | Error occurred |
| `system` | System event |
| `elapsed=Xms` | Milliseconds since request received |
| `status=200` | HTTP status (2xx green, 4xx/5xx red) |
| `backend=` / `model=` | Routing target |

### Debugging commands

```bash
# Debug-level logs (every step)
LOG_LEVEL=debug bash start.sh

# Watch metrics live
watch -n 1 'curl -sk https://127.0.0.1:8443/anthropic/v1/metrics | jq'

# Run the Node process only (no Caddy, plain HTTP for curl tests)
node index.js
```

## Troubleshooting

> When the router goes dark, it's almost always one of these.

### `Port 8787/8443 is still occupied`

The script already cleans ports. If it still fails:

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
lsof -nP -iTCP:8443 -sTCP:LISTEN
# Kill the offending PIDs manually, then re-run start.sh
```

### Browser / client error `ERR_CERT_AUTHORITY_INVALID` or `certificate verify failed`

The local root CA isn't trusted yet:

```bash
mkcert -install
```

Chrome / Firefox require a restart. For Python clients that still fail:

```bash
export SSL_CERT_FILE=$(mkcert -CAROOT)/rootCA.pem
export REQUESTS_CA_BUNDLE=$(mkcert -CAROOT)/rootCA.pem
```

### Upstream returns `401 Unauthorized` / `403 Forbidden`

1. Check `apiKey` in the corresponding `backends.json` entry
2. If `apiKey` is empty, the gateway pulls from the client's `Authorization: Bearer <token>` header — ensure the client sends it
3. Azure OpenAI and similar services that require `api-version` query params need to be appended to `baseUrl`

### Upstream returns `404 Not Found` / `model not found`

The names in `models` are passed **as-is** as the upstream request's `model` field. They must exactly match the upstream's official model IDs.

### Claude Code Desktop connects but shows no models

1. `Auth scheme` must be `bearer`
2. `Gateway base URL` must **not** have a trailing `/`, and must include `/anthropic` (e.g. `https://127.0.0.1:8443/anthropic`)
3. Verify `https://127.0.0.1:8443/anthropic/v1/models` returns a non-empty list

### Stream cuts off mid-response

- Check `upstream_errors` in `curl -sk https://127.0.0.1:8443/anthropic/v1/metrics`
- `LOG_LEVEL=debug bash start.sh` to see per-request SSE event sequence
- If always tied to a specific tool call, the upstream may have a non-standard tool protocol

### Anthropic client → OpenAI backend: where did `thinking` output go?

OpenAI doesn't support reasoning blocks yet — the gateway merges Anthropic-style thinking into regular `content`. The reverse direction (OpenAI → Anthropic) behaves the same. See Roadmap.

### `node: command not found` / `caddy: command not found`

Reopen the terminal after installing; verify `which node caddy mkcert` returns paths in `$PATH`.

### macOS mkcert shows `unknown CA`

Keychain permission denied: run `mkcert -uninstall && mkcert -install` and enter your admin password.

## Security

**This project is a local dev tool, not a production gateway.** Please note:

- The service binds to `127.0.0.1` only and is not exposed to the network. Don't change this to `0.0.0.0`; for remote access, use VPN / SSH tunnels.
- `backends.json` contains real API keys and is `.gitignore`d — **never commit it** and avoid it appearing in screenshots.
- mkcert's root CA is only trusted on your local machine; if `rootCA-key.pem` leaks, attackers can MITM you.
- The gateway has no authentication: any local process that can reach `127.0.0.1:8443` can use your API keys. Not suitable for shared multi-user machines.
- For production deployment, at minimum: real TLS certs, API key rotation, auth middleware, rate limiting, audit logging, containerization.

## FAQ

**Q: Why "OpenProxyRouter"?**
A: The name says it all — it's an open-source router that proxies AI protocol requests. No mythology, just function. **Open** (open source) + **Proxy** (it proxies) + **Router** (it routes). Every piece does what it says.

**Q: Why the `/anthropic` path prefix?**
A: Caddy may proxy other services on the same host; the prefix isolates them. If this is the only service, drop the prefix in the Caddyfile.

**Q: What happens if `apiKey` is empty?**
A: The gateway extracts from the client's `Authorization: Bearer <token>` header and forwards to the upstream. Useful for multi-tenant setups.

**Q: How do I add a new OpenAI-compatible provider?**
A: Add one `type: "openai"` entry to `backends.json`. DeepSeek, Moonshot, Qwen, GLM, SiliconFlow, OpenRouter — all work.

**Q: Is Claude's extended thinking supported?**
A: Yes. The gateway normalizes `thinking.enabled: true` / `thinking.budget_tokens` to `thinking.type: "adaptive"` (AWS Bedrock doesn't support the former).

**Q: What happens to reasoning / extended thinking when an OpenAI client calls Claude?**
A: Currently, Anthropic's thinking blocks are merged into `content` when converting back to OpenAI format. PRs for dedicated field support welcome.

**Q: What does the response `model` field show?**
A: The upstream's actual model name. Your client's `model` request field is mapped to the backend's real model name.

**Q: Can I use this in production?**
A: This is designed as a **local dev / personal tool**. Production requires: removing the 127.0.0.1 binding, real TLS certs, auth middleware, systemd or k8s management.

**Q: Will crashes lose requests?**
A: `start.sh` has process supervision — crashes restart within 5s. The gateway has a 30s SIGTERM drain window so in-flight requests complete.

**Q: What about performance?**
A: Local forwarding with <1ms conversion overhead. Keep-alive connection pools reuse upstream sockets.

**Q: How do I access the token usage dashboard?**
A: Open `https://127.0.0.1:8443/dashboard` in a browser (or `http://127.0.0.1:<PORT>/dashboard` directly). The dashboard shows per-model token breakdowns (input/output/cache), TTFT, ITL, QPS, token/s. Use the time-range presets for filtering. Data persists in SQLite across restarts.

## Project Structure

```
openproxyrouter/
├── index.js               # Main entry point — HTTP server + routing + /_dashboard
├── src/
│   ├── config.js          # All constants (ports, timeouts, breaker, etc.)
│   ├── logger.js          # Structured logger + ctx.attachUsage seam (TTY/JSON)
│   ├── metrics.js         # In-memory metrics + P50/P95/P99 latency
│   ├── backend.js         # Backend registry, upstream calls, circuit breaker
│   ├── thinking.js        # Thinking configuration normalization
│   ├── token_estimate.js  # Token estimation for count_tokens endpoint
│   ├── converters.js      # All 4 protocol converters + SSE translators + parseAnthropicSSEUsage
│   ├── handlers.js        # All 4 proxy handlers with 8 capture points for token usage
│   ├── http_utils.js      # JSON response helper
│   ├── usage_recorder.js  # Central token usage normalization + recording seam
│   ├── store.js           # SQLite persistence: WAL, batched writes, 365d retention, analytics queries
│   ├── dashboard_html.js  # Web dashboard UI (Chart.js, time-range filtering, per-model metrics)
│   └── *.test.js          # 115 unit tests
├── start.sh               # Launch & supervise script (Heimdall)
├── package.json           # Declares undici as sole runtime dependency
├── backends.json          # Backend config, gitignored (create manually)
├── README.md              # English (this file)
├── README.zh.md           # Chinese
└── LICENSE
```

## Development

```bash
# Run tests
npm test

# Syntax check
npm run lint

# Run the gateway only (no Caddy, plain HTTP)
node index.js
```

### Contributing

PRs welcome. For large changes, open an issue first. See Roadmap for suggested directions.

## Roadmap

- [ ] Anthropic thinking block → OpenAI `reasoning_content` passthrough
- [ ] Embeddings API support
- [ ] Advanced rate limiting
- [ ] Docker image (Caddy + gateway)
- [ ] Optional web admin UI
- [ ] Request/response recording for offline debugging
- [ ] Native protocol support for Gemini / Bedrock

## Acknowledgements

- [Caddy](https://caddyserver.com/) — local HTTPS reverse proxy
- [mkcert](https://github.com/FiloSottile/mkcert) — trusted local certs
- [undici](https://github.com/nodejs/undici) — high-performance HTTP client
- [Anthropic](https://www.anthropic.com/) — Claude & Claude Code Desktop
- [OpenAI](https://openai.com/) — de facto protocol standard

## License

[MIT](./LICENSE) © xq25478