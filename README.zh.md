# OpenProxyRouter — 开源 AI 协议路由器

<p align="center">
  <strong>双向协议转换 AI 网关 · 让 OpenAI 与 Anthropic 生态自由互通</strong>
</p>

<p align="center">
  <em>一个极简依赖的本地 HTTPS 网关，在 OpenAI 与 Anthropic 协议之间双向翻译，按模型名路由，让任意客户端无需改动代码即可对接任意后端。</em>
</p>

<p align="center">
  <em><strong>OpenProxyRouter</strong> 名副其实：一个开源的代理路由器，专门转发 AI 协议请求。你可以把它理解成一个万能转接头——OpenAI 客户端调 Anthropic 后端，Anthropic 客户端调 OpenAI 后端，全部通过同一个本地端点完成。不用改 SDK，不受厂商锁定，只有路由。</em>
</p>

<p align="center">
  <a href="./README.zh.md"><strong>中文</strong></a> ·
  <a href="./README.md">English</a>
</p>

<p align="center">
  <a href="#这是什么">概览</a> ·
  <a href="#亮点">亮点</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#双向协议转换">协议转换</a> ·
  <a href="#客户端接入">客户端接入</a> ·
  <a href="#架构">架构</a> ·
  <a href="#配置">配置</a> ·
  <a href="#api">API</a> ·
  <a href="#日志与调试">日志</a> ·
  <a href="#常见问题排查">排查</a> ·
  <a href="#安全说明">安全</a> ·
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

## 这是什么

你手里有某家厂商的 API Key。你有一个心头爱的客户端——Codex、Claude Code Desktop、Cursor，或者下个季度才会发布的某个新工具。厂商和客户端说着不同的协议。换条路通常意味着换 SDK、改胶水代码，或者干等客户端官方支持。

**OpenProxyRouter 不再等了。** 把任何讲 OpenAI 或 Anthropic 协议的客户端指向 `https://127.0.0.1:8443/anthropic`，网关会根据请求里的 `model` 字段，自动选择要调哪个后端、要翻译成哪种协议。流式、工具调用、图片、thinking、usage——全部完整保留。

- **OpenAI 客户端**（Cursor / LangChain / Aider / Continue.dev……）可以直接调用 **Claude / Anthropic 模型**
- **Anthropic 客户端**（Claude Code Desktop / anthropic SDK）可以直接调用 **GPT / DeepSeek / 通义 / GLM / Moonshot** 等 OpenAI 兼容模型
- 同一个地址、同一份配置、按 `model` 名自动路由

换句话说：**客户端代码永远不用改，换模型只改一个字符串。**

```
         ╔════════════════════════════════════════════════════════════╗
         ║                   OpenProxyRouter                         ║
         ║                                                            ║
   OpenAI ├─► /v1/chat/completions  ─►  ┌─ Anthropic 后端 (协议转换) ─┤
   客户端  │                             │                            │
         │                             └─ OpenAI 后端    (直传)      ─┤
         ║                                                            ║
  Anthropic├─► /v1/messages          ─►  ┌─ Anthropic 后端 (直传)    ─┤
   客户端  │                             │                            │
         │                             └─ OpenAI 后端    (协议转换) ─┤
         ╚════════════════════════════════════════════════════════════╝
            客户端协议                        后端协议
         （你想用什么）                    （你配置了什么）
```

## 亮点

- **协议无关**：OpenAI SDK / Anthropic SDK / Claude Code Desktop / curl / LangChain / LiteLLM / Cursor / Continue.dev 皆可接入
- **模型无关**：Claude、GPT、DeepSeek、通义、Moonshot、GLM、Ollama 等统一入口
- **路径无关**：同一网关同时监听 `/v1/messages` 和 `/v1/chat/completions`
- **极简依赖**：`undici` 负责 HTTP 请求转发 + `better-sqlite3` 负责 Token 持久化存储，一次性 `npm install`
- **模块化代码**：`src/` 目录下清晰拆分为 config、logger、metrics、converters、handlers 等模块
- **协议双向转换**：流式 SSE、tool calls、图片、system prompt、usage 全链路保留
- **本地 HTTPS**：mkcert + Caddy，证书受系统信任
- **进程守护**：自带健康检查、自动重启、优雅关闭（30s 排空）
- **可观测**：结构化日志（TTY 中文彩色 / 管道 JSON）+ Metrics 端点（P50/P95/P99、Token 统计）
- **使用量仪表板**：内置 Web UI（`/_dashboard`）— 按模型统计 Token 总量、缓存命中、TTFT、ITL、QPS、Token/s，Chart.js 可视化 + 时间段筛选
- **持久化存储**：SQLite（WAL 模式 + 批量写入）+ 365 天数据保留 — 重启不丢数据
- **精确 Token 采集**：通过 API 响应数据捕获全部 8 个路径组合的用量（含流式/非流式、直传/转换），杜绝漏统
- **Thinking 适配**：自动将 `thinking.enabled` 规范化为 AWS Bedrock 兼容的 `adaptive`
- **测试覆盖**：115 个单元测试覆盖转换器、thinking、指标、token 估算、使用量记录、SSE 解析和熔断器

## 快速开始

> 从「我有一个 API Key」到「这台机器上的每个客户端都能调用每个模型」。剩下的事情，交给 `start.sh` 里的守护进程。

### 1. 安装系统依赖

**macOS**

```bash
brew install node caddy mkcert
```

**Linux (Debian / Ubuntu)**

```bash
# Node.js ≥ 18
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

**Windows**：推荐在 WSL2 下按 Linux 步骤安装。原生 Windows 未测试。

版本要求：Node.js ≥ 18 / Caddy ≥ 2.6 / mkcert ≥ 1.4。

### 2. 克隆项目

```bash
git clone https://github.com/xq25478/OpenProxyRouter.git
cd OpenProxyRouter
```

### 3. 安装 Node 依赖

```bash
npm install
```

唯一运行时依赖包含 [`undici`](https://github.com/nodejs/undici)（Node 高性能 HTTP 客户端）+ [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)（同步 SQLite，Token 持久化）。如 `better-sqlite3` 编译失败，网关正常运行但无持久化存储。

### 4. 配置后端

在项目根目录创建 `backends.json`。数组中每一项描述一个上游后端：

| 字段      | 必填 | 说明                                                                                          |
| --------- | ---- | --------------------------------------------------------------------------------------------- |
| `type`    | 是   | `"anthropic"` 或 `"openai"`，决定网关用哪种协议与该后端通信。                                 |
| `name`    | 否   | 后端别名，仅用于日志和启动横幅展示。                                                          |
| `baseUrl` | 是   | 上游接口地址。Anthropic 兼容后端通常以 `/anthropic` 或根路径结尾；OpenAI 兼容后端以 `/v1` 结尾。 |
| `apiKey`  | 是   | 上游真实 API Key。如果上游无需鉴权，填 `"EMPTY"`。                                            |
| `models`  | 是   | 该后端承载的模型 ID 列表。路由按请求中的 `model` 字段精确匹配，所有后端的模型 ID 必须全局唯一。 |

`backends.json` 示例：

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

> `backends.json` 已加入 `.gitignore`，含真实 Key，**切勿提交**。

### 5. 启动

```bash
bash start.sh
```

`start.sh` 会自动：
- 检查系统依赖（node / caddy / mkcert / curl / lsof）
- 生成 mkcert 本地 TLS 证书
- 写入 Caddyfile 配置
- 启动 Node 网关（`127.0.0.1:8787`）和 Caddy HTTPS 反代（`127.0.0.1:8443`）
- 进入守护循环（崩溃自动拉起）

### 6. 验证启动

看到类似输出表示成功：

```
Gateway base URL:
  https://127.0.0.1:8443/anthropic

Models (5 total):
  - Claude-Opus-4.7
  - gpt-4o
  - DeepSeek-V4-Pro
  - ...
```

浏览器访问 `https://127.0.0.1:8443/anthropic/v1/models` 应返回 JSON 模型列表（首次访问需信任 mkcert 证书）。

### 7. 停止 / 重启 / 卸载

- **停止**：在 `start.sh` 前台终端按 `Ctrl+C`。网关对 SIGTERM 有 30s 排空窗口，进行中的请求会正常完成。
- **重启**：脚本自带进程守护，Caddy/Node 崩溃后 5 秒内自动拉起；手动重启只需再次 `bash start.sh`，脚本会自动清理旧进程与端口。
- **后台运行**：
  ```bash
  nohup bash start.sh > gateway.log 2>&1 &
  ```
- **完全卸载**：
  ```bash
  # 停掉进程
  lsof -nP -iTCP:8787 -sTCP:LISTEN -t | xargs -r kill
  lsof -nP -iTCP:8443 -sTCP:LISTEN -t | xargs -r kill

  # 删证书
  rm -rf ~/.certs/claude-proxy
  # 从系统信任库移除 mkcert 根 CA（会影响 mkcert 签发的其他证书，谨慎）
  mkcert -uninstall

  # 删除仓库
  rm -rf /path/to/OpenProxyRouter
  ```

## 双向协议转换

这是本项目的**核心能力**。下表列出了四种组合：

| 客户端协议 | 后端类型 | 处理方式 | 典型场景 |
|:---------:|:---------:|:--------:|:--------|
| **OpenAI** `/v1/chat/completions` | `anthropic` | **协议转换** | OpenAI SDK 调用 Claude |
| **OpenAI** `/v1/chat/completions` | `openai` | 直传 | OpenAI SDK 调用 GPT / DeepSeek |
| **Anthropic** `/v1/messages` | `anthropic` | 直传 | Claude Code Desktop 调用 Claude |
| **Anthropic** `/v1/messages` | `openai` | **协议转换** | Claude Code Desktop 调用 GPT |

协议转换覆盖：

| 能力 | OpenAI → Anthropic | Anthropic → OpenAI |
|------|:------------------:|:------------------:|
| 基本对话 | ✅ | ✅ |
| System prompt | ✅ | ✅ |
| 流式 SSE（逐 token） | ✅ | ✅ |
| Tool calls / function calling | ✅ | ✅ |
| 多轮 tool_result | ✅ | ✅ |
| 图片输入（base64 / URL） | ✅ | - |
| Stop sequences | ✅ | ✅ |
| Temperature / top_p | ✅ | ✅ |
| Usage 统计（含缓存 token） | ✅ | ✅ |
| finish_reason ↔ stop_reason | ✅ | ✅ |
| Thinking 归一化 | ✅ | ✅ |

## 客户端接入

### OpenAI Python SDK（推荐）

一次配置，调用任何模型：

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://127.0.0.1:8443/anthropic/v1",
    api_key="any-string",                    # apiKey 在 backends.json 里
)

# 调用 Claude（协议自动转换）
resp = client.chat.completions.create(
    model="Claude-Opus-4.7",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)

# 同样的代码调用 GPT（直传）
resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}],
)

# 同样的代码调用 DeepSeek
resp = client.chat.completions.create(
    model="DeepSeek-V4-Pro",
    messages=[{"role": "user", "content": "Hello"}],
)

# 流式同样工作
for chunk in client.chat.completions.create(
    model="Claude-Opus-4.7",
    messages=[{"role": "user", "content": "写一首诗"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")

# Function calling 同样工作
resp = client.chat.completions.create(
    model="Claude-Opus-4.7",
    messages=[{"role": "user", "content": "北京天气"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "get_weather",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
        },
    }],
)
```

**TLS 证书信任**：首次使用时，请先 `mkcert -install` 让系统信任本地根 CA。若 Python 仍提示证书错误，可设置：

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

# 调用 Claude（直传）
resp = client.messages.create(
    model="Claude-Opus-4.7",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)

# 调用 GPT（协议自动转换）
resp = client.messages.create(
    model="gpt-4o",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
```

### Claude Code Desktop

在 Settings → Gateway 中填：

| 配置项 | 值 |
|--------|-----|
| Gateway base URL | `https://127.0.0.1:8443/anthropic` |
| Gateway API key | 任意字符串（或留空） |
| Gateway auth scheme | `bearer` |

然后在模型下拉中即可看到所有配置的模型，包括 GPT / DeepSeek 等。

### curl 快速测试（所有 4 种组合）

```bash
# 1. OpenAI 协议 → Anthropic 后端（协议转换）
curl -k https://127.0.0.1:8443/anthropic/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Claude-Opus-4.7","messages":[{"role":"user","content":"hi"}]}'

# 2. OpenAI 协议 → OpenAI 后端（直传）
curl -k https://127.0.0.1:8443/anthropic/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'

# 3. Anthropic 协议 → Anthropic 后端（直传）
curl -k https://127.0.0.1:8443/anthropic/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"Claude-Opus-4.7","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'

# 4. Anthropic 协议 → OpenAI 后端（协议转换）
curl -k https://127.0.0.1:8443/anthropic/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"gpt-4o","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```

### 其他支持 OpenAI 兼容协议的工具

下面的工具**全部可以直接接入**（把 base URL 指向 `https://127.0.0.1:8443/anthropic/v1`）：

- **Cursor** / **Continue.dev** / **Zed AI** — 用 Claude 作为编码助手
- **LangChain** / **LlamaIndex** / **LiteLLM** — 统一后端，自由切换模型
- **Open WebUI** / **LibreChat** / **ChatGPT-Next-Web** / **LobeChat** — 自托管聊天界面
- **Aider** / **Cline** / **Roo-Code** — 命令行 / IDE 编码助手
- **Dify** / **FastGPT** — LLM 应用平台

<details>
<summary><strong>Cursor 配置示例</strong></summary>

Settings → Models → OpenAI API Key 填任意字符串；OpenAI Base URL 填：
```
https://127.0.0.1:8443/anthropic/v1
```
然后在 Model Override 里添加 `Claude-Opus-4.7` 等网关暴露的模型名。
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
<summary><strong>LiteLLM 代理</strong></summary>

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
<summary><strong>Cline (VS Code 扩展)</strong></summary>

API Provider 选 "OpenAI Compatible"：
- Base URL: `https://127.0.0.1:8443/anthropic/v1`
- API Key: 任意字符串
- Model ID: `Claude-Opus-4.7` 或任一网关暴露的模型
</details>

<details>
<summary><strong>Open WebUI</strong></summary>

Settings → Connections → OpenAI API：
- API Base URL: `https://127.0.0.1:8443/anthropic/v1`
- API Key: 任意字符串
</details>

## 架构

> 三层结构：TLS 卸载、协议路由、上游转发。一个路由器从来只需要三块板。

```
┌─────────────────────────────────────────────────────────────────┐
│  客户端                                                         │
│  OpenAI SDK / Anthropic SDK / Claude Code Desktop / curl / ... │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS (mkcert 证书本地信任)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Caddy :8443                                                    │
│  - TLS 卸载                                                     │
│  - 反向代理到 Node 网关                                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP (仅 127.0.0.1)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Node Gateway :8787 (index.js + src/ 模块)                       │
│                                                                 │
│  1. 路由分发：/v1/messages  或  /v1/chat/completions            │
│  2. 解析 body.model，查 modelIndex 定位后端                     │
│  3. 按 (客户端协议, 后端类型) 组合选择处理器：                  │
│                                                                 │
│     proxyRequest            —— Anthropic → Anthropic (直传)     │
│     proxyOpenAIChat         —— Anthropic → OpenAI   (协议转换)  │
│     proxyOpenAIDirect       —— OpenAI    → OpenAI   (直传)      │
│     proxyAnthropicAsOpenAI  —— OpenAI    → Anthropic (协议转换) │
│                                                                 │
│  4. 流式 SSE 实时转换 / 非流式整体转换                          │
│  5. 错误处理 / Metrics 记录 / 日志输出                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP/HTTPS
                           ▼
                     上游 API（混合后端）
                 Anthropic  OpenAI  DeepSeek  ...
```

## 配置

### `backends.json`

```json
[
  {
    "type": "anthropic",
    "name": "显示名称",
    "baseUrl": "https://api.anthropic.com",
    "apiKey": "sk-ant-...",
    "models": ["model-a", "model-b"]
  }
]
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `"anthropic"` \| `"openai"` | 后端协议类型 |
| `name` | string | 仅用于日志显示 |
| `baseUrl` | string | 后端 base URL（OpenAI 兼容后端含或不含 `/v1` 均可） |
| `apiKey` | string | API Key；留空则从客户端 `Authorization: Bearer` 头提取 |
| `models` | string[] | 该后端暴露的模型名，**全局必须唯一**（客户端按此名路由） |

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

### 端口

- `8787` Node 网关（仅 127.0.0.1）
- `8443` Caddy HTTPS（仅 127.0.0.1）

修改方式：`src/config.js` 中 `PORT` + `start.sh` 中 `CADDY_PORT`。

### 更多后端配置示例

下面列出常用的 OpenAI 兼容厂商配置，直接追加到 `backends.json` 数组即可。

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
Azure 的 URL 需带 deployment 名，且需要 `?api-version=...`。可在 `baseUrl` 上直接拼。
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
<summary><strong>SiliconFlow (硅基流动)</strong></summary>

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
<summary><strong>Moonshot (月之暗面)</strong></summary>

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
<summary><strong>智谱 GLM</strong></summary>

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
<summary><strong>通义千问 (DashScope 兼容模式)</strong></summary>

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
<summary><strong>火山方舟 / 豆包</strong></summary>

```json
{
  "type": "openai",
  "name": "Doubao",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
  "apiKey": "...",
  "models": ["doubao-pro-32k", "doubao-pro-128k"]
}
```
豆包的 `models` 填的是**推理接入点 ID**（如 `ep-xxx`）或实际模型名。
</details>

<details>
<summary><strong>本地 Ollama</strong></summary>

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

> **⚠️ 提醒**：`models` 数组里的名字必须**全局唯一**（跨所有后端）。客户端正是通过这个名字路由到对应后端的。

## API

所有路径均以 `/anthropic` 为前缀（便于在一台机器上和其他服务共存）。

### Anthropic 协议

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/anthropic/v1/messages` | Messages API（支持流式、工具、图片） |
| `POST` | `/anthropic/v1/messages/count_tokens` | Token 估算（本地计算） |

### OpenAI 协议

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/anthropic/v1/chat/completions` | Chat Completions API |

### 模型发现

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/anthropic/v1/models` | 列出所有配置的模型 |
| `GET` | `/anthropic/v1/models/{id}` | 查询单个模型 |

### 运维

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/anthropic/v1/metrics` | 请求统计、延迟分位、错误数、Token 用量 |
| `GET` | `/` | 健康检查 |
| `HEAD` | `/` | 健康检查（静默） |
| `GET` | `/dashboard` | Web 仪表板页面 |
| `GET` | `/dashboard/api` | 仪表板 JSON API（参数 `from`、`to` 为 epoch 毫秒） |

### Metrics 示例

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

## 日志与调试

终端直接输出。TTT 下为彩色格式，管道中为 JSON（便于 `jq` / 日志采集）：

```
[08:35:45] 系统 loaded 5 backends, 5 models
[08:35:45] 系统 listening on http://127.0.0.1:8787
[08:35:46] 收到请求 50eb2cce POST /anthropic/v1/chat/completions
[08:35:46] 路由到   50eb2cce POST /anthropic/v1/chat/completions 耗时=1ms 后端=OpenAI 模型=gpt-4o
[08:35:46] 完成     50eb2cce POST /anthropic/v1/chat/completions 状态=200 耗时=491ms 后端=OpenAI
```

字段说明：

| 字段 | 含义 |
|---|---|
| `[时间]` | 本地时间 HH:MM:SS |
| `事件` | `收到请求` / `路由到` / `完成` / `出错` / `系统` |
| 8 位 ID | 请求 ID（rid），用于跨行关联同一请求 |
| `耗时=Xms` | 请求从收到到当前事件的毫秒数（`完成` 对应总耗时） |
| `状态=200` | HTTP 状态码（2xx 绿 / 4xx & 5xx 红） |
| `后端=` / `模型=` | 路由目标 |

### 调试命令

```bash
# 调试级别日志（输出每一步细节）
LOG_LEVEL=debug bash start.sh

# 实时观察 metrics
watch -n 1 'curl -sk https://127.0.0.1:8443/anthropic/v1/metrics | jq'

# 仅跑 Node 进程（不走 Caddy，便于 curl 测试）
node index.js
```

## 常见问题排查

> 路由器若失联，多半就是下面这几桩。

### 启动时提示 `Port 8787/8443 is still occupied`

脚本已自带端口清理，若仍失败：

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
lsof -nP -iTCP:8443 -sTCP:LISTEN
# 根据 PID 手动 kill，再重跑 start.sh
```

### 浏览器 / 客户端报 `ERR_CERT_AUTHORITY_INVALID` 或 `certificate verify failed`

本地根 CA 未注册到系统信任库：

```bash
mkcert -install
```

Chrome / Firefox 需要重启后生效。Python 客户端若仍不信任：

```bash
export SSL_CERT_FILE=$(mkcert -CAROOT)/rootCA.pem
export REQUESTS_CA_BUNDLE=$(mkcert -CAROOT)/rootCA.pem
```

### 上游返回 `401 Unauthorized` / `403 Forbidden`

1. 检查 `backends.json` 中对应后端的 `apiKey` 是否正确
2. 若 `apiKey` 字段留空，网关会从客户端的 `Authorization: Bearer <token>` 头提取——确认客户端已传
3. Azure OpenAI 等需要 `api-version` query 参数的服务，需在 `baseUrl` 上补齐

### 上游返回 `404 Not Found` / `model not found`

`backends.json` 的 `models` 数组里填的名字，会**原样**作为上游请求的 `model` 字段转发。务必与上游官方文档的 model id 完全一致。

### Claude Code Desktop 连接后看不到模型

1. `Auth scheme` 必须选 `bearer`
2. `Gateway base URL` 末尾不要带 `/`，且包含 `/anthropic` 前缀（如 `https://127.0.0.1:8443/anthropic`）
3. 访问 `https://127.0.0.1:8443/anthropic/v1/models` 确认模型列表非空

### 流式响应中途断开

- 先看 `curl -sk https://127.0.0.1:8443/anthropic/v1/metrics` 中的 `upstream_errors` 是否增加
- `LOG_LEVEL=debug bash start.sh` 查看单请求的 SSE 事件序列
- 若固定出现在某个 tool call 上，可能是上游对 tool 协议的实现存在差异

### Anthropic 客户端 → OpenAI 后端：thinking 输出去哪了

目前 OpenAI 不支持 reasoning 块，网关会把 Anthropic 风格的 thinking 合并进常规 content；反方向（OpenAI → Anthropic）同理。详见 Roadmap。

### `node: command not found` / `caddy: command not found`

新装工具后需重开终端；或检查 `which node caddy mkcert` 返回的路径是否在 `$PATH` 中。

### macOS 下 mkcert 报 `unknown CA`

Keychain 权限被拒：执行 `mkcert -uninstall && mkcert -install` 并输入管理员密码。

## 安全说明

**本项目定位为本地个人开发工具，不是生产级网关。** 使用时请注意：

- 服务**仅绑定 `127.0.0.1`**，默认不暴露到外网。不要擅自改成 `0.0.0.0`；如需跨机访问，请走 VPN / SSH 隧道。
- `backends.json` 里有真实 API Key，已在 `.gitignore` 中——**不要提交到公共仓库**，不要在截图中出现。
- mkcert 根 CA 仅在本机受信任；如果把 `rootCA-key.pem` 泄露，攻击者可对你的机器发起中间人攻击。
- 网关本身不做鉴权：凡是能连上 `127.0.0.1:8443` 的本机进程都能用你的 API Key。多用户共享机器的场景不适合直接部署。
- 若需生产部署，至少还要加：真实 TLS 证书、上游 API Key 轮转、请求鉴权中间件、速率限制、审计日志、容器化运行。

## FAQ

**Q：为什么叫 "OpenProxyRouter"？**
A：顾名思义——开源的代理路由器。**Open**（开源）+ **Proxy**（代理）+ **Router**（路由）。不玩神话梗，每一个词都说清楚它做什么。开放源码，代理请求，路由分发，干净利落。

**Q：为什么路径前缀是 `/anthropic`？**
A：Caddy 可能在同一本机反代其他服务，用前缀隔离。只用本网关时可在 Caddyfile 里去掉 prefix。

**Q：`apiKey` 留空会怎样？**
A：网关会从客户端请求头 `Authorization: Bearer <token>` 提取，转发给上游。可用于多租户。

**Q：如何添加一个新的 OpenAI 兼容厂商？**
A：`backends.json` 里加一条 `type: "openai"` 即可。DeepSeek、Moonshot、通义、智谱、SiliconFlow、OpenRouter 全部兼容。

**Q：Claude 的 extended thinking 支持吗？**
A：支持。网关会把 `thinking.enabled: true` / `thinking.budget_tokens` 规范化为 `thinking.type: "adaptive"`（AWS Bedrock 不支持前者）。

**Q：OpenAI 客户端调用 Claude 时，reasoning / extended thinking 会怎样？**
A：目前 Anthropic 的 thinking 块在转换回 OpenAI 格式时会被合并进 `content`。如需单独字段支持，欢迎 PR。

**Q：响应 `model` 字段显示什么？**
A：显示上游返回的真实模型名。客户端请求里的 `model` 会被网关映射到后端真实模型名。

**Q：如何用于生产环境？**
A：本项目设计为**本地开发/个人使用工具**。生产部署需：去掉 127.0.0.1 绑定 / 换真实 TLS / 增加鉴权中间件 / 用 systemd 或 k8s 管理。

**Q：崩溃时会丢请求吗？**
A：`start.sh` 带进程守护，崩溃 5s 内自动拉起。网关对 SIGTERM 有 30s 排空窗口，进行中的请求能完成。

**Q：性能如何？**
A：本地转发，除协议转换开销（< 1ms）外几乎无额外延迟。keep-alive 连接池复用上游 socket。

**Q：如何查看 Token 用量仪表板？**
A：浏览器打开 `https://127.0.0.1:8443/dashboard`（或 `http://127.0.0.1:<端口>/dashboard` 直接访问）。仪表板展示每个模型的 Token 细分（输入/输出/缓存命中）、TTFT、ITL、QPS、Token/s。可通过时间范围预设进行筛选。数据持久化存储在 SQLite 中，重启不丢失。

## 项目结构

```
openproxyrouter/
├── index.js               # 主入口 —— HTTP 服务器 + 路由分发 + /_dashboard
├── src/
│   ├── config.js          # 全局常量（端口、超时、熔断器配置等）
│   ├── logger.js          # 结构化日志 + ctx.attachUsage 采集接缝（TTY/JSON）
│   ├── metrics.js         # 内存指标 + P50/P95/P99 延迟
│   ├── backend.js         # 后端注册表、上游调用、熔断器
│   ├── thinking.js        # Thinking 配置归一化
│   ├── converters.js      # 4 × 协议转换器 + SSE 流翻译器 + parseAnthropicSSEUsage
│   ├── handlers.js        # 全部 4 个代理处理器 + 8 个 Token 捕获点
│   ├── http_utils.js      # JSON 响应工具函数
│   ├── usage_recorder.js  # Token 归一化 + 统一记录接缝
│   ├── store.js           # SQLite 持久化：WAL 模式、批量写入、365 天保留、分析查询
│   ├── dashboard_html.js  # Web 仪表板 UI（Chart.js、时间段筛选、逐模型指标）
│   └── *.test.js          # 115 个单元测试
├── start.sh               # 启动守护脚本（Heimdall）
├── package.json           # 声明 undici + better-sqlite3 依赖
├── backends.json          # 后端配置，gitignored（需手动创建）
├── README.md              # 英文
├── README.zh.md           # 中文（本文件）
└── LICENSE
```

## 开发

```bash
# 运行测试
npm test

# 语法检查
npm run lint

# 仅跑网关进程（不带 Caddy，直接 HTTP）
node index.js
```

### 贡献

欢迎 PR。大的改动请先开 Issue 讨论。建议的贡献方向见 Roadmap。

## Roadmap

- [ ] Anthropic thinking block → OpenAI `reasoning_content` 透传
- [ ] Embeddings API 支持
- [ ] 高级速率限制
- [ ] Docker 镜像（含 Caddy + 网关）
- [ ] 可选的 Web 管理界面
- [ ] 请求/响应录制，用于离线调试
- [ ] 对 Gemini / Bedrock 原生协议的支持

## 致谢

- [Caddy](https://caddyserver.com/) — 本地 HTTPS 反代
- [mkcert](https://github.com/FiloSottile/mkcert) — 本地受信任证书
- [undici](https://github.com/nodejs/undici) — 高性能 HTTP 客户端
- [Anthropic](https://www.anthropic.com/) — Claude 与 Claude Code Desktop
- [OpenAI](https://openai.com/) — 事实上的协议标准

## License

[MIT](./LICENSE) © xq25478