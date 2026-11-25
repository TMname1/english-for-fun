/**
 * ASR ChatModel 单测：只验证「怎么发请求、怎么把原生响应搬回 LangChain 消息」，
 * 不覆盖真实 DashScope 行为（端到端链路走 transcribe 子图，见 graph/transcribe-*.ts）。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMResult } from "@langchain/core/outputs";

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { HumanMessage } from "@langchain/core/messages";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";

import { asrSentencesOf, DashScopeAsrChatModel } from "../asr-model";

const AUDIO = `data:audio/wav;base64,${Buffer.from("fake-wav").toString("base64")}`;

const SYNC_RESPONSE = {
  request_id: "req-1",
  output: {
    sentence: {
      sentence_id: 1,
      begin_time: 100,
      end_time: 2000,
      text: "I like the food.",
      sentence_end: true,
      words: [
        { text: "I", begin_time: 100, end_time: 300 },
        { text: "like", begin_time: 400, end_time: 700 },
        { text: "the", begin_time: 800, end_time: 900 },
        { text: "food", begin_time: 1000, end_time: 1900, punctuation: "." },
      ],
    },
  },
};

function model(overrides: Partial<ConstructorParameters<typeof DashScopeAsrChatModel>[0]> = {}) {
  return new DashScopeAsrChatModel({
    audio: AUDIO,
    language: "en",
    durationSec: 12.5,
    apiKey: "sk-test",
    baseUrl: "https://asr.example/generation",
    model: "qwen-audio-3.1-asr-flash",
    timeoutMs: 1000,
    ...overrides,
  });
}

let fetchMock: jest.Mock;
const realFetch = global.fetch;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
});

function ok(body: unknown) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe("DashScopeAsrChatModel", () => {
  it("按原生 multimodal 协议发请求，并把句子塞回 additional_kwargs", async () => {
    ok(SYNC_RESPONSE);

    const msg = await model().invoke([new HumanMessage("转写")]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://asr.example/generation");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");

    const body = JSON.parse(init.body);
    expect(body.model).toBe("qwen-audio-3.1-asr-flash");
    expect(body.input.messages[0].content[0]).toEqual({
      type: "input_audio",
      input_audio: { data: AUDIO },
    });
    expect(body.parameters).toEqual({
      format: "wav",
      sample_rate: "16000",
      language_hints: ["en"],
    });

    // 毫秒时间戳原样保留，换算交给 asr.ts（buildTranscriptFromSentences）
    expect(asrSentencesOf(msg)[0].begin_time).toBe(100);
    expect(msg.content).toBe("I like the food.");
    expect(msg.response_metadata).toMatchObject({ request_id: "req-1", word_count: 4 });
  });

  it("invocationParams 不含音频 base64（否则一条 trace 上百 MB）", () => {
    const params = model().invocationParams();
    expect(params.model).toBe("qwen-audio-3.1-asr-flash");
    expect(params.language_hints).toEqual(["en"]);
    expect(params.audio_seconds).toBe(12.5);
    expect(JSON.stringify(params)).not.toContain("base64");
    expect(JSON.stringify(params)).not.toContain(AUDIO.slice(30, 60));
  });

  it("HTTP 失败抛出带状态码的错误", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"code":"InvalidApiKey"}',
    });
    await expect(model().invoke([new HumanMessage("转写")])).rejects.toThrow(
      /转写请求失败（HTTP 400）.*InvalidApiKey/,
    );
  });

  it("作为 Runnable 会触发 callback（Langfuse 靠这条链路拿观测）", async () => {
    ok(SYNC_RESPONSE);
    const starts: unknown[] = [];
    const ends: LLMResult[] = [];
    class Spy extends BaseCallbackHandler {
      name = "spy";
      handleChatModelStart = (_llm: unknown, _messages: unknown, _runId: string) => {
        starts.push(_runId);
      };
      handleLLMEnd = (output: LLMResult) => {
        ends.push(output);
      };
    }
    const spy = new Spy();

    const m = model({ callbacks: [spy] });
    await m.invoke([new HumanMessage("转写")]);

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0].generations[0][0].text).toBe("I like the food.");
  });

  it("父链路的 callbacks 经 AsyncLocalStorage 下发到 ASR 调用（图内就是这么继承的）", async () => {
    ok(SYNC_RESPONSE);
    AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage());
    let seen = 0;
    class Spy extends BaseCallbackHandler {
      name = "spy";
      handleChatModelStart = () => {
        seen += 1;
      };
    }
    // LangGraph 在节点执行时用 runWithConfig 把节点 config（含图根 handler）灌进 ALS；
    // 模型自身没挂 callbacks，必须靠这条隐式配置继承，否则图内 ASR 会漏 trace。
    await AsyncLocalStorageProviderSingleton.runWithConfig({ callbacks: [new Spy()] }, async () =>
      model().invoke([new HumanMessage("转写")]),
    );

    expect(seen).toBe(1);
  });
});
