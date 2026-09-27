<div align="center">

# minimax-m3-provider

**OpenClaw 插件:以 OpenAI Responses 协议接入 MiniMax M3 / M3.1 Flash Preview —— 聊天/文本 + 图片理解 + 视频理解**

*OpenClaw plugin: MiniMax M3 & M3.1 Flash Preview over the OpenAI Responses API — chat/text with reasoning-preserving replay, plus image and video understanding*

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.9.3-blue.svg)](https://github.com/openclaw/openclaw)
[![Provider](https://img.shields.io/badge/provider-minimax--tp-ff5c5c.svg)](https://platform.minimax.cn)
[![Transport](https://img.shields.io/badge/transport-openai--responses-orange.svg)](https://platform.minimax.cn)
[![Modalities](https://img.shields.io/badge/modalities-text%20%7C%20image%20%7C%20video-purple.svg)](#媒体理解--media-understanding)

</div>

---

## 简介 / Introduction

本插件把 **MiniMax M3** 注册为 OpenClaw 的 Provider,一个 provider id(`minimax-tp`)同时覆盖两条链路:

1. **聊天 / 文本** —— `api.registerProvider`,走 **OpenAI Responses 兼容端点**(`POST /v1/responses`)。
   推理内容(reasoning)在 Responses 协议里是一等 output item,转录会原生回传,多轮 thinking
   天然连续,无需任何请求体补丁。
2. **图片 / 视频理解** —— `api.registerMediaUnderstandingProvider`,用 Responses 的
   `input_image` / `input_video` content part 调用同一个端点。

This plugin registers **MiniMax M3** under a single provider id (`minimax-tp`) that serves two
extension surfaces: chat/text over the **OpenAI Responses** endpoint, and image/video
understanding via `input_image` / `input_video` content parts.

### 为什么用 Responses?/ Why Responses?

Responses 协议下,历史消息里的 `reasoning` item 会**原样回传给模型**(OpenClaw 的
`openai-compatible` replay family 不会丢弃它),因此跨轮次的思考链是连续的。Chat Completions
路线则要手工把 `reasoning_content` 塞回请求体,这正是本插件放弃它的原因。

---

## 特性 / Highlights

| | |
|---|---|
| 🧠 **原生推理回传** | `reasoning` 是一等 output item,多轮思考连续,不需要补丁 |
| 🖼️ **图片理解** | 走 `input_image`,`detail` 可配 low / default / high |
| 🎬 **视频理解** | 走 `input_video`,支持抽帧率(`fps` 0.2–5)与清晰度调节 |
| ⚡ **优先队列** | `serviceTier: "priority"` 开关(1.5 倍价,插队准入、更低延迟) |
| 💾 **提示缓存** | `promptCacheKey` 开关,透传 MiniMax `prompt_cache_key` |
| 🔌 **零配置默认** | 只填 API Key 即可用,默认 `https://api.minimax.cn/v1` |
| 🧩 **单插件双能力** | 聊天 + 媒体理解合并在一个插件里,不用装两个 |

---

## 安装 / Installation

### 方式一:ClawHub(推荐)/ via ClawHub

```bash
openclaw plugins search minimax-m3
openclaw plugins install clawhub:@mirr0ch1/minimax-m3-provider
systemctl --user restart openclaw-gateway   # 或 openclaw gateway restart
```

### 方式二:GitHub 仓库 / via GitHub

```bash
openclaw plugins install Mirr0ch1/minimax-m3-provider-openclaw
```

### 方式三:手动 / Manual

```bash
git clone https://github.com/Mirr0ch1/minimax-m3-provider-openclaw.git \
  ~/coding/minimax-m3-provider-openclaw
```

然后在 `~/.openclaw/openclaw.json` 中启用:

```json5
{
  plugins: {
    allow: ["minimax-m3-provider"],
    load: { paths: ["~/coding/minimax-m3-provider-openclaw"] },  // 或放进 ~/.openclaw/extensions/
    entries: {
      "minimax-m3-provider": { enabled: true },
    },
  },
}
```

### 写入 API Key

```bash
echo 'MINIMAX_TOKEN_PLAN_API_KEY=your-key-here' >> ~/.openclaw/.env
```

模型选择器读的是 `models.providers`(插件目录只负责动态发现),所以还要显式写一段:

```json5
{
  models: {
    providers: {
      "minimax-tp": {
        baseUrl: "https://api.minimax.cn/v1",
        apiKey: "${MINIMAX_TOKEN_PLAN_API_KEY}",
        api: "openai-responses",
        timeoutSeconds: 7200,
        models: [
          {
            id: "MiniMax-M3",
            name: "MiniMax-M3",
            api: "openai-responses",
            reasoning: true,
            input: ["text", "image", "video"],
            contextWindow: 1000000,
            maxTokens: 131072,
          },
          {
            id: "MiniMax-M3.1-Flash-Preview",
            name: "MiniMax-M3.1-Flash-Preview",
            api: "openai-responses",
            reasoning: true,
            input: ["text"],
            contextWindow: 1000000,
            maxTokens: 131072,
            compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      // 否则 agent 用不了(把要用到的模型都列上)
      modelPolicy: { allow: ["minimax-tp/MiniMax-M3", "minimax-tp/MiniMax-M3.1-Flash-Preview"] },
    },
  },
}
```

重启网关后验证:

```bash
openclaw plugins list | grep -i minimax
openclaw models list  | grep -i minimax
```

---

## 配置 / Configuration

插件配置位于 `plugins.entries["minimax-m3-provider"].config`(注意 key 是**插件 id**,不是 provider id):

```json5
{
  plugins: {
    entries: {
      "minimax-m3-provider": {
        enabled: true,
        config: {
          serviceTier: "priority",     // standard(默认) | priority
          promptCacheKey: "my-cache",  // 可选,透传 prompt_cache_key
        },
      },
    },
  },
}
```

| 选项 / Option | 类型 | 默认值 | 说明 / Description |
|---|---|---|---|
| `serviceTier` | `standard` \| `priority` | — | MiniMax `service_tier`。`priority` = 1.5 倍价,优先队列准入(更少失败、更低延迟)。 |
| `promptCacheKey` | string | — | 透传 MiniMax `prompt_cache_key`,用于提示缓存。 |

> 两个字段都只在**未显式设置**时注入,不会覆盖其它来源的取值。
> Both fields are injected only when absent, so they never clobber an explicit value.

### 媒体理解相关环境变量 / Media env vars

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MINIMAX_TOKEN_PLAN_API_KEY` / `MINIMAX_API_KEY` | — | API 密钥(前者优先)。 |
| `MINIMAX_IMAGE_DETAIL` | `high` | `input_image.detail`:`low` \| `default` \| `high`。 |
| `MINIMAX_VIDEO_DETAIL` | `high` | `input_video.detail`:`low` \| `default` \| `high`。 |
| `MINIMAX_VIDEO_FPS` | `2` | 视频抽帧率,有效范围 0.2–5。 |

---

## 模型 / Models

| 模型 / Model | 输入 | 上下文 | 最大输出 | 推理 |
|---|---|---|---|---|
| `MiniMax-M3` | text + image + video | 1,000,000 | 131,072 | ✅ 开关式 |
| `MiniMax-M3.1-Flash-Preview` | text | 1,000,000 | 131,072 | ✅ 强度可调(low→max) |

> 输出的上游硬上限是 524,288,这里取官方推荐值 131,072。视频/图片理解链路的
> `max_output_tokens` 固定为 2000(描述类任务足够,且避免思考把预算吃光)。
>
> `MiniMax-M3.1-Flash-Preview` 目前**仅通过 Token Plan / MiniMax Code 提供**(和本插件
> 默认使用的 `MINIMAX_TOKEN_PLAN_API_KEY` 一致),官方定位为文本模型,因此输入只声明
> `text`。上下文/输出上限沿用 M3 的同族取值,如官方后续公布不同数字请按需调整。

---

## 思考等级 / Thinking Levels

### M3.1 Flash Preview:真实档位,`high` → `max`

M3.1 的 `reasoning` **始终开启**,`effort` 是真实强度旋钮
(`low` / `medium` / `high` / `xhigh` / `max`,省略时服务端默认 `max`),
且 `effort: "none"` 会直接返回 **HTTP 400**。因此该模型**不提供 `off` 档**。

`/think` 接受 `low` / `medium` / `high`,默认 `high`,由插件在 `wrapStreamFn`
里把档位钉成 MiniMax 的 `reasoning.effort`:

| 等级 / Level | `reasoning.effort` | 说明 |
|---|---|---|
| `high` | `max` | **OpenClaw 的最高档映射到模型最高档** |
| `medium` | `medium` | 直通 |
| `low` | `low` | 直通 |
| `off`(仅遗留会话状态) | `low` | 模型无法真正关闭思考,退化到最省档;不下发 `none` |
| `xhigh` / `max` / `ultra` | `max` | 兼容其它 Provider 切换过来的档位 |

> 为什么必须在插件里钉?OpenClaw 核心默认把 `high` 原样写成 `"high"`(对 M3.1 只是中等),
> 而 `off` 时干脆**不写 `reasoning` 字段** —— 那会被 M3.1 当成默认的 `max`。两头都错,
> 所以插件在请求体上做显式映射。

### M3:开关式

`/think` 接受 `off` / `low` / `medium` / `high`,默认 `high`:

| 等级 / Level | `reasoning.effort` | 效果 |
|---|---|---|
| `off` | *(不下发字段)* | OpenClaw 在 `off` 时根本不写 `reasoning`,等价于不思考 |
| `low` / `medium` / `high` | `low` / `medium` / `high` | **M3 不区分强度,三者均只是"开启思考"** |

> ⚠️ **M3 的 effort 是开关而不是旋钮。** 只要是非 `none` 的值,思考强度完全一致;
> `low` / `medium` / `high` 的存在只是为了从其它 Provider 切换过来时 `/think high` 不报错。
>
> MiniMax M3 does not grade reasoning intensity: any non-`none` effort simply enables
> thinking. The three levels exist for provider-switch compatibility only.

---

## 媒体理解 / Media Understanding

注册为 `image` + `video` 双能力的媒体理解 Provider,`autoPriority` 为 `10`(高于
stepfun / minimax 兜底档),默认模型都是 `MiniMax-M3`。

| 能力 | content part | 支持格式 | 可调参数 |
|---|---|---|---|
| 图片 | `input_image` | JPEG / PNG / GIF / WEBP | `detail`(low / default / high) |
| 视频 | `input_video` | MP4 / AVI / MOV / MKV | `fps` 0.2–5、`detail` |

媒体理解的默认提示词(prompt)可在 `index.js` 的 `DEFAULT_PROMPT` 处修改:

```
请详细描述这个多媒体内容，包括所有可见信息（画面、动作、文字、场景等）。
```

> 媒体走的是 `resolveProviderHttpRequestConfig` + `postJsonRequest`,与聊天链路复用同一份
> baseUrl / 鉴权 / 网络策略(含私网与代理处理)。

---

## 实测行为 / Verified Behaviour

以下均为对着线上网关实测(2026-08/09),不是从文档抄的:

1. **端点** `POST https://api.minimax.cn/v1/responses`,鉴权 `Authorization: Bearer <token>`。
   中国大陆域名已从 `api.minimaxi.com` 迁到 **`api.minimax.cn`**;实测两域名并行可用、行为一致
   (旧域名未停服),本插件默认写死新域名。
2. **图片输入**用 data URL(`data:image/png;base64,...`),`detail` 三档均可。
3. **视频输入**用 data URL(`data:video/mp4;base64,...`),`fps` 实测 2 稳定。
4. **历史可携带 `reasoning` item**,多轮思考链连续;这是本插件选 Responses 的核心理由。
5. **`reasoning.effort` 语义按模型不同**:M3 是开关(`none` 关闭,其余值只是"开启");
   M3.1 Flash Preview 是强度旋钮(`low`→`max`,始终开启,`none` 报 400)。
6. **`service_tier: "priority"`** 被网关接受,走优先队列(计费 1.5 倍)。

---

## 故障排除 / Troubleshooting

| 现象 / Symptom | 原因与处理 / Cause & Fix |
|---|---|
| 模型列表里没有 `MiniMax-M3` / `MiniMax-M3.1-Flash-Preview` | 没解析到密钥,或没写 `models.providers.minimax-tp`。插件目录只负责动态发现,选择器读配置。 |
| `not allowed for agent ... by agents.defaults.modelPolicy.allow` | 把对应模型(`minimax-tp/...`)加进 `modelPolicy.allow`。 |
| `/think high` 时 M3.1 没有真的用 `max` | 检查模型 id 是否命中 `MiniMax-M3.1-*`(插件靠它判断是否钉 effort);providers 里 `api` 必须仍是 `openai-responses`。 |
| `/think off` 在 M3.1 上仍会思考 | 预期行为:M3.1 无法关闭思考,插件把它退化为 `effort: "low"`(最省),而不是下发会被 400 拒绝的 `none`。 |
| 改了 `baseUrl` 不生效 | `models.providers["minimax-tp"].baseUrl` 与插件默认值(写死在 `index.js`)是两处。 |
| 插件启用了但模型没出现 | 检查 `plugins.allow` 里是否有 `minimax-m3-provider`(是**插件 id**,不是 `minimax-tp`)。 |
| 媒体理解不走 M3 | 检查是否有更高 `autoPriority` 的视觉 Provider 抢占;M3 的优先级是 10。 |
| 重启网关后头几个请求失败 | 网关 warm-up 竞态,等约 20s 再试,不是插件问题。 |

---

## 从旧插件 `minimax-m3` 迁移 / Migrating from `minimax-m3`

本插件的插件 id 已从 `minimax-m3` 规范化为 **`minimax-m3-provider`**(provider id `minimax-tp` 不变)。
老配置需要改 key:

```json5
{
  plugins: {
    // allow: ["minimax-m3"],                    // ← 旧 id,删掉
    allow: ["minimax-m3-provider"],               // ← 改成插件新 id
    entries: {
      // "minimax-m3": { enabled: false },       // ← 旧条目,删掉
      "minimax-m3-provider": { enabled: true },   // ← 换成新条目
    },
  },
}
```

`models.providers["minimax-tp"]`、`minimax-tp/MiniMax-M3` 等引用**完全不用动**。

> ⚠️ 先禁用/卸载旧插件再启用新插件:两者会注册同一个 provider id `minimax-tp`,同时加载会冲突。

---

## 更新日志 / Changelog

**v1.1.0**(2026-09-28)
- 新增 `MiniMax-M3.1-Flash-Preview` 模型接入(文本输入,Responses API,Token Plan)
- 思考档位映射:该模型下 OpenClaw `high` → MiniMax `max`,由插件在 `wrapStreamFn` 钉入
- 思考档位按模型区分:M3.1 不提供 `off`(模型无法关闭思考,`effort:"none"` 会 400),
  `off` 退化到 `low`
- 该模型的 `max_output_tokens`/`contextWindow` 沿用 M3 同族取值

**v1.0.0**(2026-09-17)
- 项目规范化改名为 `minimax-m3-provider-openclaw`,插件 id 从 `minimax-m3` 改为 `minimax-m3-provider`
- 首次发布到 ClawHub(`@mirr0ch1/minimax-m3-provider`)与 GitHub
- 合并了旧插件 `minimax-m3-thinking-fix` 与 `minimax-video-understand` 的能力:
  一个插件同时注册 chat provider 与 image/video 媒体理解 Provider
- 中国大陆端点已迁移到 `api.minimax.cn`

---

## 开发 / Development

```bash
git clone https://github.com/Mirr0ch1/minimax-m3-provider-openclaw.git
cd minimax-m3-provider-openclaw
```

目录结构 / Layout:

```
├── index.js                 # 聊天 provider + 媒体理解 provider + Responses 调用
├── openclaw.plugin.json     # manifest:contracts、configSchema、媒体理解元数据
├── package.json
└── README.md
```

把仓库路径加进 `plugins.load.paths` 即可热改热调,无需反复拷贝。

---

## 许可 / License

[MIT](LICENSE)
