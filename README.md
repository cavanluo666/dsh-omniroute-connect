# dsh-omniroute-connect

**插件自己就是网关。** 把多个 OpenAI 兼容上游（OpenAI、DeepSeek、Groq、
本地 Ollama……）聚合成 DeepSeek Harness 里的一个 provider 路由 `omniroute`，
自带**路由策略、失败回退、断路器**。

装上之后多出一个 provider，**不会**改动你现在的默认模型——
在模型选择器里切到 `omniroute` 下的模型才会用到它。

---

## 它解决什么问题

你手上有好几个模型的 API：一个主力、一个便宜的兜底、一个本地跑的。
现在你想：

- 主力限流了，**自动**换下一个，而不是那个回合直接失败；
- 已经坏掉的上游别每次都去撞一遍、等它超时；
- 便宜的任务走便宜的那家，重要的走贵的那家；
- 一家密钥过期了，另一家还能顶上。

这个插件就是干这个的。它**不依赖任何外部进程**——没有 OmniRoute 要装，
没有本地端口要守，全部在这个插件里。

## 安装

```bash
git clone https://github.com/<your-name>/dsh-omniroute-connect.git
dsh plugin --profile web add link:./dsh-omniroute-connect
```

这一条命令把依赖写进 `~/.dsh/profiles/web/package.json`，并把插件追加进
`dsh.profile.bundles`。装好后**重启 dsh**（新增 bundle 需要重新解析组合层）。

## 快速开始

装上之后打开「插件 → dsh-omniroute-connect」。全新安装时里面已经有**一条
内置的免密钥上游**，所以可以直接用；要接自己的模型就点「添加上游」。

## 内置的免密钥通道

出厂预置一条 `opencode.ai` 的免鉴权通道，让插件装上就有东西可用，
不需要你先去申请任何密钥。

**必须说清楚三件事**：

1. 那是**别人家的免费额度**，随时可能失效、限流或关停。
2. 它的 `/models` 会列出 85 个模型，但**绝大多数在这个出口上返回 403**
   （免费额度按账号/地区网关，不是「列出来就能用」）。
   验证结论：只有 `space-bunny-free` 正常应答；
   `mimo-*` / `nemotron-*` / `longcat-*` 一律 403，
   而 `claude-*` / `gemini-*` 这类非 `-free` 模型是 401（要单独密钥）。
   所以默认只预置**验证过的那一个**，而不是列一屏看着漂亮、
   点下去全报错的模型。要看全部可用项就在卡片上点「探测可用模型」。
3. 它在界面上单独标注「内置 / 免密钥」。你配上自己的上游之后，
   可以直接把它的开关关掉。

## 核心概念

| 概念 | 含义 |
|---|---|
| **上游 (upstream)** | 一个 OpenAI 兼容 endpoint：名字 + 基础地址 + 密钥 + 它服务的模型 |
| **路由策略** | 一次请求该先试谁 |
| **回退链** | 首选失败后依次试的顺序（**始终是配置里的顺序**，见下） |
| **断路器** | 某上游连续失败到阈值就被临时摘掉，不再去撞它 |

### 路由策略

| 策略 | 行为 |
|---|---|
| **按顺序**（默认） | 永远用列表里第一个可用的，它挂了才用下一个。最可预测。 |
| **记住上次好的** | 优先用最近一次成功的那个。适合「主用一家、偶尔兜底」。 |
| **按权重** | 按每个上游配的权重随机选，权重高的概率大。 |
| **轮询** | 轮流用，把请求平摊到各家。适合分摊免费额度。 |
| **最快优先** | 优先用最近平均响应最快的。需要先积累一些请求。 |
| **成本优先** | 优先用单价最低的（按每家配的 $/M tok）。 |

一个刻意的设计：**策略只决定「首选是谁」，回退顺序永远是配置里的顺序**。
把整个回退链也随机化会让行为不可复现——出了问题没人能说清
「为什么这次走到了第三家」。例外是「最快优先」和「成本优先」，
它们的偏好本身就是全序的，所以直接用排序结果，行为仍然可解释。

### 断路器

```
closed ──连续失败到阈值──▶ open ──冷却结束──▶ half-open（放一个探测过去）
  ▲                                              │
  └──────────── 探测成功 ────────────────────────┘
                    │
                探测失败 ──▶ open（重新计时）
```

**哪些失败会记到它头上**——这是这里最重要的判断：

| 情况 | 计数？ | 为什么 |
|---|---|---|
| 5xx、超时、连不上、限流、鉴权失败 | **是** | 上游自己的毛病，换一家确实可能好 |
| 400 请求非法、413 上下文超长、模型不存在 | **否** | 换一家大概率一模一样，白花一次往返和配额 |
| 用户主动取消 | **否** | 不是上游的错 |

**默认是「计入」**，只有明确知道「换一家也没用」的那几种才跳过。
这一条来自一次真实的翻车：默认写成「不认识就不计入」时，上游用
`200 + 流内 error` 报的错（错误码必然是自定义字符串）全被静默丢弃，
断路器永远不拉闸，于是每次请求都要先去撞一遍那个坏掉的上游。

### 并行竞速（默认关闭）

同一个请求同时发给前 N 家，取最快开始回答的。

**它会真的多花钱**：只有 1 个答案被采用，另外 N-1 个已经在上游那边
产生了 token。所以它默认关闭，且界面上写明了这一点。
只有「首字节延迟比钱重要」时才值得开。

实现上做了两件必须做对的事：

1. **赢家出现后立刻取消其余请求**，否则它们在后台跑完照样计费；
2. **输家不被记成失败**——输掉是竞速的预期结果，不是上游有病。
   把输家记成失败会让所有上游很快全被拉闸。

## 配置

存在插件自己的文件里，不走 profile patch（改一个开关不该触发整个
Loader 树 reconcile 和插件热重载）：

```
$DSH_HOME/omniroute-connect/config.json
```

也可以在 `cordis.patch.yml` 里预置（入口配置是默认层，用户层覆盖它）：

```yaml
- insert:
    - id: llm-omniroute
      name: 'dsh-omniroute-connect'
      config:
        enabled: true
        strategy: priority        # priority | lkgp | weighted | round-robin
                                  # | least-latency | cost-first
        raceEnabled: false
        raceWidth: 2
        upstreams:
          - id: main
            name: 主力
            baseURL: https://api.deepseek.com/v1
            apiKey: sk-...
            models: [deepseek-chat, deepseek-reasoner]
            weight: 1
          - id: backup
            name: 兜底
            baseURL: https://api.groq.com/openai/v1
            apiKey: gsk-...
            models: [llama-3.3-70b]
            inputPricePerMTok: 0.59
            outputPricePerMTok: 0.79
```

| 上游字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | 必填 | 必须以 `http(s)://` 开头；末尾斜杠会被去掉 |
| `apiKey` | 空 | 空 = 这个上游不需要密钥（本地 Ollama 就是这样） |
| `models` | `[]` | 留空 = **接受任何模型 id**；填了就只路由这些模型 |
| `enabled` | `true` | 停用后不参与路由，但配置保留 |
| `weight` | `1` | 「按权重」策略用 |
| `inputPricePerMTok` / `outputPricePerMTok` | 未填 | 「成本优先」策略用；不填就不参与比较 |
| `timeoutMs` | `120000` | 这个上游的请求超时 |
| `breakerThreshold` | `3` | 连续失败几次拉闸 |
| `breakerCooldownMs` | `60000` | 拉闸后多久自动半开重试 |

**密钥从不回传给浏览器**：管理页只知道「设了没有」，改地址时
留空表示「不改动」（用一个显式占位符表达，服务端换成已存的值）——
否则用户改个地址会顺手把密钥抹掉，而界面上看不出这件事发生过。

## 开发

渲染测试需要 `react` / `react-test-renderer`（仅测试期依赖），先装一次：

```bash
npm install            # 只需要跑 client.test.mjs 时
node run-tests.mjs     # 四套自检
```

如果你的环境已有一份可复用的 React，可以用
`DSH_CLIENT_TEST_MODULES=<含它们的 node_modules 路径>` 指过去，跳过 `npm install`。
`host.test.mjs` 需要能解析到宿主提供的 `@deepseek-ai/cordis`；
找不到时可用 `DSH_CORDIS_PATH` 显式指定。

| 套件 | 覆盖 |
|---|---|
| `transport.test.mjs` | SSE 分帧、思维链/工具调用的 block 索引、usage 口径、消息投影 |
| `gateway.test.mjs` | 真 HTTP 假上游跑端到端：路由、回退、断路器、竞速、上游方言 |
| `host.test.mjs` | 用最小 cordis 上下文真的跑一遍 `apply()` 与适配器 |
| `client.test.mjs` | 真的渲染一遍管理页，把「空白槽位」变成明确的失败 |

## 模块地图

| 文件 | 职责 |
|---|---|
| `transport.js` | OpenAI 协议翻译（消息投影、SSE → StreamChunk、usage 口径） |
| `gateway-model.js` | 上游与策略的数据模型、校验、默认值 |
| `gateway-breaker.js` | 断路器三态与健康统计 |
| `gateway-router.js` | 候选排序 + 回退执行 |
| `gateway-upstream.js` | 与**一个**上游说话（含免密钥通道的指纹握手） |
| `gateway.js` | 把上面四块接起来：一次请求的完整生命周期 |
| `adapter.js` | `LlmAdapter` 契约面 + harness 图片 → data URL |
| `store.js` | 配置存储（入口层 + 用户层） |
| `index.js` | 插件入口：注册路由、管理页接口 |
| `client.js` | 浏览器管理页 |

## 实现上的三个要点

**usage 口径要对齐。** OpenAI 的 `prompt_tokens` 是**含缓存**的总额，
而 harness 要求输入侧是互不重叠的三个数（未缓存输入 / 缓存读 / 缓存写）。
适配器会把缓存命中量减出去——不减的话，每一次带缓存命中的对话
都会把输入 token 重复计一遍。

**HTTP 200 不等于成功。** 上游经常用 `200 + 流内 error` 帧报错。
所以一次尝试的「成功」判定被推迟到读到第一个**有内容的**帧为止——
否则一个包着错误的 200 会被当成答案吐给用户。

**`inject` 必须是具名导出。** cordis 只把 `inject` 里列出的服务挂到
上下文对象上；漏了它，`ctx.llm` 会直接抛
`cannot get property "llm" without inject`。

## 已知的运维注意

这个插件是**链接安装**（`link:`）的，所以改动源码后 dsh 的 HMR 会重新
加载模块。但如果某次装载失败，失败的那一代模块会被进程缓存住；
随后的文件修改**不会**被重新导入，错误信息会一直停在旧的行号上。
这种情况需要重启 dsh 才能拿到新代码。

## 与 OmniRoute 的关系

这个插件的设计借鉴了 [OmniRoute](https://www.omniroute.online) 的思路
（多上游路由 + 回退 + 断路器），但**不依赖它**：没有外部进程、
没有本地端口、不需要先装什么。

## 许可证

本项目以 **GNU General Public License v3.0 or later** 发布，
完整条款见 [`LICENSE`](LICENSE)。

```
Copyright (C) 2026 LCH
```

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.

> 关于内置的免密钥通道：它连接的是第三方（opencode.ai）的公开网关，
> 使用的是对方公开的池化凭据。该通道随时可能失效或变更，
> 请遵守对方的使用条款，不要用于滥用。
