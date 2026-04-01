# Model Catalog And Chain Config

> 更新日期：2026-04-01

## 目标

把当前“role 里内联写模型名”的方式，升级成两层配置：

1. model catalog
2. chain catalog

让角色只声明：

- `modelRef`
- 或 `modelChain`

而不再把 provider/base URL/credentials/fallback 逻辑散落在 role 配置里。

## 当前实现

### 1. 模型定义层

模型 catalog 现在支持两种写法：

- 旧格式：`models` 数组
- 新格式：`models` 对象映射

单模型支持的关键字段：

- `id`
- `label`
- `providerId`
- `protocol`
- `apiType`
- `model`
- `baseURL`
- `baseURLEnv`
- `apiKeyEnv`
- `headers`
- `query`
- `temperature`
- `maxOutputTokens`
- `aliases`
- `enabled`

说明：

- `protocol` 继续使用当前 runtime 的协议名：
  - `openai-compatible`
  - `anthropic-compatible`
- `apiType` 是新的简写别名：
  - `openai`
  - `anthropic`
- `baseURL` 和 `baseURLEnv` 二选一即可

### 2. 执行链层

新增 `modelChains`：

- 旧格式：`modelChains` 数组
- 新格式：`modelChains` 对象映射

每条 chain 支持：

- `id`
- `primary`
- `fallbacks`
- `aliases`
- `enabled`

这层只负责声明：

- primary model id
- fallback model ids

不负责再声明 credentials 或 base URL。

### 3. role 引用层

`RoleSlot` 现在支持三种入口：

- `modelChain`
- `modelRef`
- 旧字段 `model`

优先级：

1. `modelChain`
2. `modelRef`
3. `model.name`（legacy）

## runtime 行为

### LLM 调用

`LLMGateway` 现在会先解析 role 选择：

- 如果有 `modelChain`，先取 chain
- 如果 chain 不存在且同时给了 `modelRef`，回退到 `modelRef`
- 否则使用 `modelRef`
- 再否则使用 legacy `model.name`

chain 命中后，调用顺序为：

1. primary
2. fallback[0]
3. fallback[1]
4. ...

返回结果会带：

- `modelId`
- `modelChainId`（如果有）
- `attemptedModelIds`

### Heuristic fallback

当前仍保留外层：

- `LLM -> heuristic`

也就是说现在已经有两层 fallback：

1. chain 内的 `LLM -> LLM`
2. response generator 外层的 `LLM -> heuristic`

## Prompt / Budget 行为

Prompt policy 现在会优先通过 model catalog 解析 role 的 primary model，再推断 context window。

这保证：

- role 只写 `modelChain` 时
- prompt budget 仍然能看到真实 primary model

而不是退化成只看到 chain id。

## 兼容策略

第一版保持向后兼容：

- `models` 数组仍然可用
- role 旧字段 `model` 仍然可用
- daemon demo role 现在同时写 `modelRef + modelChain`

这样旧的本地 `models.json` 即使还没有 `modelChains`，默认 demo role 也不会立刻失效。

## 推荐配置形态

JSON 示例：

```json
{
  "defaultModelId": "gpt-5",
  "defaultModelChainId": "builder_primary",
  "models": {
    "minimax_reasoning": {
      "label": "MiniMax Reasoning",
      "providerId": "minimax",
      "apiType": "anthropic",
      "model": "MiniMax-M2.7-highspeed",
      "baseURLEnv": "MINIMAX_ANTHROPIC_BASE_URL",
      "apiKeyEnv": "MINIMAX_API_KEY"
    },
    "fireworks_kimi": {
      "label": "Fireworks Kimi",
      "providerId": "fireworks",
      "apiType": "anthropic",
      "model": "accounts/fireworks/routers/kimi-k2p5-turbo",
      "baseURLEnv": "ANTHROPIC_BASE_URL",
      "apiKeyEnv": "ANTHROPIC_AUTH_TOKEN"
    }
  },
  "modelChains": {
    "reasoning_primary": {
      "primary": "minimax_reasoning",
      "fallbacks": ["fireworks_kimi"]
    }
  }
}
```

role 侧推荐写法：

```json
{
  "roleId": "role-planner",
  "name": "Planner",
  "seat": "member",
  "runtime": "local",
  "modelChain": "reasoning_primary"
}
```

## 这版没有做的

当前还没有：

- weighted routing
- policy-based dynamic model pick
- latency/cost/quality scoring
- per-role chain override policy
- per-chain retry taxonomy

第一版目标只是先把：

- model catalog
- chain catalog
- role -> chain
- runtime fallback

这四层收成一个稳定的最小闭环。
