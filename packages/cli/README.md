# @turnkeyai/cli

TurnkeyAI 的本地优先 Agent Runtime CLI。

## Usage

```bash
npx @turnkeyai/cli daemon
```

另一个终端中连接 TUI：

```bash
npx @turnkeyai/cli tui
```

默认 daemon 地址：

- `http://127.0.0.1:4100`

可选环境变量：

- `TURNKEYAI_DAEMON_PORT`
- `TURNKEYAI_DAEMON_URL`
- `TURNKEYAI_DAEMON_TOKEN`
