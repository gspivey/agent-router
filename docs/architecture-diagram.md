# Agent Router — Architecture Diagram

## Mermaid (paste into mermaid.live or GitHub markdown)

```mermaid
flowchart TB
    subgraph inputs["Inputs"]
        direction TB
        GH["🐙 GitHub Webhooks<br/>CI failures, PR reviews, /agent commands"]
        CLI["⌨️ CLI / Terminal<br/>agent-router prompt, ls, tail"]
        EDITOR["🖥️ Editor (ACP)<br/>Cline, Zed, JetBrains"]
        WEB["🌐 Web Dashboard<br/>Mobile-friendly chat UI"]
        CRON["⏰ Cron / Scheduler<br/>Roadmap-driven every 6h"]
    end

    subgraph router["Agent Router"]
        direction TB
        WEBHOOK["POST /webhook<br/>HMAC verify"]
        IPC["Unix Socket<br/>NDJSON IPC"]
        ACP_IN["ACP Server<br/>stdio JSON-RPC"]
        HTTP["HTTP API<br/>REST + SSE"]

        WAKE["Wake Policy<br/>filter → resolve PR → lookup session → rate limit"]
        REG["Session Registry<br/>session_id → (PRs, agent, queue, files)"]
        FILES["Session Files<br/>stream.log · prompts.log · meta.json"]
        DB["SQLite<br/>events · sessions · WAL mode"]
    end

    subgraph agents["Agent Backends (ACP)"]
        direction TB
        KIRO["🤖 Kiro CLI<br/>Primary coding agent"]
        HERMES["🧠 Hermes Agent<br/>General-purpose agent"]
        FUTURE["🔮 Future Agents<br/>Claude Code, custom, etc."]
    end

    subgraph outputs["Outputs"]
        direction TB
        CODE["📝 Code Changes<br/>git worktree per feature"]
        GHPR["💬 PR Comments<br/>Post results back to GitHub"]
        STREAM["📡 Live Stream<br/>tail -f · SSE · ACP notifications"]
        NOTIFY["🔔 Notifications<br/>Telegram, Discord, etc."]
    end

    GH --> WEBHOOK
    CLI --> IPC
    EDITOR --> ACP_IN
    WEB --> HTTP
    CRON --> IPC

    WEBHOOK --> WAKE
    IPC --> REG
    ACP_IN --> REG
    HTTP --> REG

    WAKE --> REG
    REG --> FILES
    REG --> DB
    REG --> KIRO
    REG --> HERMES
    REG --> FUTURE

    KIRO --> CODE
    KIRO --> STREAM
    HERMES --> CODE
    HERMES --> STREAM
    FUTURE --> CODE

    REG --> GHPR
    REG --> NOTIFY
    FILES --> STREAM
```

## Image Prompt (for AI image generators or designers)

> A network routing diagram rendered in a clean, modern technical illustration style with a dark background. At the center is a glowing hexagonal hub labeled "Agent Router" — it looks like a physical network switch or router with ports on all sides, emitting subtle light trails.
>
> On the left side, five input cables connect to the router:
> - A purple cable from a GitHub octocat icon (webhooks)
> - A green cable from a terminal/CLI icon
> - A blue cable from a code editor icon (VS Code/Zed)
> - An orange cable from a phone/browser icon (web dashboard)
> - A gray cable from a clock icon (cron scheduler)
>
> On the right side, three output cables fan out to agent icons:
> - A bright blue cable to a Kiro robot icon
> - A teal cable to a Hermes brain icon
> - A dimmed cable to a "?" icon (future agents)
>
> Below the router, a small SQLite database icon and streaming log files glow softly.
>
> The overall aesthetic is: circuit board meets network topology diagram. Clean lines, no clutter, the router is clearly the central hub that everything passes through. The word "ROUTER" is subtly emphasized — this is a routing device, not an agent.
>
> Style references: Vercel's architecture diagrams, Cloudflare's network maps, Linear's product illustrations.
