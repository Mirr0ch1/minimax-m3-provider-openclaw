import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream";
import {
  resolveProviderHttpRequestConfig,
  postJsonRequest,
  assertOkOrThrowHttpError,
} from "openclaw/plugin-sdk/provider-http";

/**
 * Unified MiniMax M3 provider via OpenAI Responses API.
 *
 * One provider id (`minimax-tp`) serves two OpenClaw extension surfaces:
 *  1. Chat / text  -> api.registerProvider, api = "openai-responses".
 *     Reasoning continuity is preserved by the openai-compatible replay family
 *     (the Responses family does NOT drop reasoning from history).
 *  2. Image / video understanding -> api.registerMediaUnderstandingProvider,
 *     calling POST {baseUrl}/responses with input_image / input_video parts.
 *
 * MiniMax Responses API reference (smoke-tested 2026-08-19, M3.1 2026-09-28):
 *   - endpoint:  POST https://api.minimax.cn/v1/responses
 *   - auth:      Authorization: Bearer <token>
 *   - input_image:  image_url data URL, formats JPEG/PNG/GIF/WEBP, detail low/default/high
 *   - input_video:  video_url data URL, formats MP4/AVI/MOV/MKV, fps 0.2-5, detail, max_long_side_pixel
 *   - history items can include `reasoning` (thinking continuity across turns)
 *   - reasoning.effort contract differs per model (see below).
 */

const PLUGIN_ID = "minimax-m3-provider";
const PROVIDER_ID = "minimax-tp";
const DEFAULT_MODEL = "MiniMax-M3";
const DEFAULT_BASE_URL = "https://api.minimax.cn/v1";
const DEFAULT_PROMPT =
  "请详细描述这个多媒体内容，包括所有可见信息（画面、动作、文字、场景等）。";
const MAX_OUTPUT_TOKENS = 2000;

// ── 模型与思考档位 ───────────────────────────────────────────────────

/**
 * Model-aware thinking policy.
 *
 * `MiniMax-M3` — `reasoning.effort` is an on/off switch: `none` disables
 * thinking, every other value just turns it on with identical depth. An `off`
 * level is therefore meaningful and is offered.
 *
 * `MiniMax-M3.1-Flash-Preview` — reasoning is always on and `effort` is a real
 * depth knob (`low`/`medium`/`high`/`xhigh`/`max`, default `max` when omitted).
 * It answers `effort: "none"` with HTTP 400, so `off` must NOT be offered and
 * must never reach the wire.
 */
const M3_THINKING_LEVELS = ["off", "low", "medium", "high"];
const M31_THINKING_LEVELS = ["low", "medium", "high"];

/** Matches `MiniMax-M3.1-*` ids, tolerating a `provider/model` reference. */
const M31_MODEL_RE = /^minimax-m3\.1(?:$|[-.\s])/i;

function isM31Model(modelId) {
  if (typeof modelId !== "string") return false;
  const id = modelId.trim().split("/").pop();
  return M31_MODEL_RE.test(id);
}

/**
 * OpenClaw thinking level -> MiniMax-M3.1 `reasoning.effort`.
 *
 * OpenClaw's `high` is the top tier a user picks, so it maps onto the model's
 * own `max`. `off` cannot be honoured (the endpoint rejects `none`), so it
 * degrades to the cheapest enabled effort rather than being dropped — omitting
 * the field is not neutral either, because M3.1 then defaults to `max`
 * internally. `xhigh`/`max`/`ultra` also land on `max`.
 */
const M31_EFFORT_BY_LEVEL = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  adaptive: "medium",
  high: "max",
  xhigh: "max",
  max: "max",
  ultra: "max",
};

function resolveM31Effort(thinkingLevel) {
  const level =
    typeof thinkingLevel === "string" ? thinkingLevel.trim().toLowerCase() : "";
  return M31_EFFORT_BY_LEVEL[level] ?? "max";
}

// ── 参数工具 ─────────────────────────────────────────────────────────

function resolveParam(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function resolveIntEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

function guessMime(fileName, fallback) {
  if (!fileName) return fallback;
  const ext = fileName.split(".").pop()?.toLowerCase();
  return MIME_BY_EXT[ext] || fallback;
}

// ── Responses API 请求/响应 ─────────────────────────────────────────

function buildResponsesBody(params) {
  const content = [];
  if (params.prompt) content.push({ type: "input_text", text: params.prompt });
  if (params.imageDataUrl) {
    content.push({
      type: "input_image",
      image_url: { url: params.imageDataUrl, detail: params.imageDetail },
    });
  }
  if (params.videoDataUrl) {
    content.push({
      type: "input_video",
      video_url: {
        url: params.videoDataUrl,
        fps: params.videoFps,
        detail: params.videoDetail,
      },
    });
  }
  return {
    model: params.model,
    input: [{ role: "user", content }],
    max_output_tokens: params.maxTokens ?? MAX_OUTPUT_TOKENS,
  };
}

/** Extract concatenated assistant text from a Responses API payload. */
function extractResponsesText(data) {
  const items = Array.isArray(data?.output) ? data.output : [];
  const parts = [];
  for (const item of items) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (block?.type === "output_text" && block.text) parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

async function callResponses(req, opts) {
  const fetchFn = req.fetchFn ?? fetch;
  const model = resolveParam(req.model, DEFAULT_MODEL);
  const prompt = resolveParam(req.prompt, DEFAULT_PROMPT);
  const apiKey = req.auth?.kind === "api-key" ? req.auth.apiKey : req.apiKey;

  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: req.baseUrl,
      defaultBaseUrl: DEFAULT_BASE_URL,
      headers: req.headers,
      request: req.request,
      defaultHeaders: apiKey
        ? { "content-type": "application/json", authorization: `Bearer ${apiKey}` }
        : undefined,
      provider: PROVIDER_ID,
      api: "openai-responses",
      capability: opts.capability,
      transport: "media-understanding",
    });

  const url = `${baseUrl}/responses`;

  const { response: res, release } = await postJsonRequest({
    url,
    headers,
    body: buildResponsesBody({
      model,
      prompt,
      imageDataUrl: opts.imageDataUrl,
      videoDataUrl: opts.videoDataUrl,
      imageDetail: opts.imageDetail,
      videoFps: opts.videoFps,
      videoDetail: opts.videoDetail,
    }),
    timeoutMs: req.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(res, "MiniMax M3 media description failed");
    const data = await res.json();
    const text = extractResponsesText(data);
    if (!text) throw new Error("MiniMax M3 API returned no text content");
    return { text, model: data.model || model };
  } finally {
    release();
  }
}

function toDataUrl(req, kind) {
  const mime = resolveParam(
    req.mime,
    guessMime(req.fileName, kind === "video" ? "video/mp4" : "image/jpeg"),
  );
  return `data:${mime};base64,${req.buffer.toString("base64")}`;
}

// ── 插件入口 ─────────────────────────────────────────────────────────

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "MiniMax M3 Provider",
  description:
    "Unified MiniMax M3 provider via OpenAI Responses API: chat/text " +
    "(reasoning-preserving replay) + image/video understanding.",

  register(api) {
    // ── 聊天 / text 路径 ─────────────────────────────────────────────
    api.registerProvider({
      id: PROVIDER_ID,
      label: "MiniMax M3 (Responses)",

      // openai-compatible replay: for openai-responses modelApi, reasoning is
      // NOT dropped from history -> interleaved thinking stays continuous.
      ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),

      // Thinking policy is per-model: M3 is an on/off thinker; M3.1 Flash
      // Preview always reasons and must not be offered `off`.
      resolveThinkingProfile: ({ modelId }) =>
        isM31Model(modelId)
          ? {
              levels: M31_THINKING_LEVELS.map((id) => ({ id })),
              defaultLevel: "high",
            }
          : {
              levels: M3_THINKING_LEVELS.map((id) => ({ id })),
              defaultLevel: "high",
            },

      // Inject MiniMax-specific body fields:
      //   reasoning.effort          -> M3.1 only; maps OpenClaw `high` -> `max`
      //   service_tier: "priority"  -> 1.5x price, priority queue admission
      //   prompt_cache_key          -> prompt caching
      //
      // The service_tier / prompt_cache_key injections stay optional (only
      // filled when absent). The M3.1 effort pin is not optional: core's own
      // resolver maps `high` to `"high"`, which M3.1 treats as a *mid* level,
      // and core drops the field entirely for `off` — which M3.1 silently
      // reads as its `max` default.
      wrapStreamFn: (ctx) => {
        const baseStreamFn = ctx.streamFn;
        if (!baseStreamFn) return undefined;
        const cfg = ctx.config?.plugins?.entries?.[PLUGIN_ID]?.config ?? {};
        const m31Effort = isM31Model(ctx.modelId)
          ? resolveM31Effort(ctx.thinkingLevel)
          : undefined;
        if (!m31Effort && !cfg.serviceTier && !cfg.promptCacheKey) {
          return undefined;
        }
        return (model, context, options) => {
          if (
            model.provider !== PROVIDER_ID ||
            model.api !== "openai-responses"
          ) {
            return baseStreamFn(model, context, options);
          }
          return streamWithPayloadPatch(
            baseStreamFn,
            model,
            context,
            options,
            (payloadObj) => {
              if (m31Effort) {
                const reasoning =
                  payloadObj.reasoning &&
                  typeof payloadObj.reasoning === "object" &&
                  !Array.isArray(payloadObj.reasoning)
                    ? { ...payloadObj.reasoning }
                    : {};
                reasoning.effort = m31Effort;
                payloadObj.reasoning = reasoning;
              }
              if (cfg.serviceTier && payloadObj.service_tier === undefined) {
                payloadObj.service_tier = cfg.serviceTier;
              }
              if (
                cfg.promptCacheKey &&
                payloadObj.prompt_cache_key === undefined
              ) {
                payloadObj.prompt_cache_key = cfg.promptCacheKey;
              }
            },
          );
        };
      },
    });

    // ── image / video 媒体理解路径 ──────────────────────────────────
    api.registerMediaUnderstandingProvider({
      id: PROVIDER_ID,
      capabilities: ["image", "video"],
      defaultModels: { image: DEFAULT_MODEL, video: DEFAULT_MODEL },
      autoPriority: { image: 10, video: 10 },

      describeImage: async (req) =>
        callResponses(req, {
          capability: "image",
          imageDataUrl: toDataUrl(req, "image"),
          imageDetail: resolveParam(process.env.MINIMAX_IMAGE_DETAIL, "high"),
        }),

      describeVideo: async (req) =>
        callResponses(req, {
          capability: "video",
          videoDataUrl: toDataUrl(req, "video"),
          videoFps: resolveIntEnv("MINIMAX_VIDEO_FPS", 2),
          videoDetail: resolveParam(process.env.MINIMAX_VIDEO_DETAIL, "high"),
        }),
    });
  },
});
