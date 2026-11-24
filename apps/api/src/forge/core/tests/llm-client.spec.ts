/**
 * 降级链单测：mock 掉 @langchain/openai，驱动 jsonSchema → jsonObject → text 三档。
 * 这里只验证「按什么顺序试、什么时候放弃、能力缓存是否生效」，真实请求行为不覆盖。
 */
import { ChatOpenAI } from "@langchain/openai";

import { callLlmJson, resetRungCache } from "../llm-client";

jest.mock("@langchain/openai", () => ({
  ChatOpenAI: jest.fn(),
}));

const MockChatOpenAI = ChatOpenAI as unknown as jest.Mock;

interface StubBehaviour {
  /** withStructuredOutput 调用的行为（抛错 / 返回对象） */
  structured?: () => Promise<unknown>;
  /** 普通 invoke 的行为 */
  invoke?: () => Promise<{ content: unknown }>;
}

function stubModel(behaviours: StubBehaviour[]) {
  let call = 0;
  MockChatOpenAI.mockImplementation(() => {
    const behaviour = behaviours[Math.min(call++, behaviours.length - 1)];
    return {
      withStructuredOutput: jest.fn(() => ({
        invoke: async () => (behaviour.structured ? behaviour.structured() : {}),
      })),
      invoke: async () => (behaviour.invoke ? behaviour.invoke() : { content: "" }),
    };
  });
}

const messages = [{ role: "user" as const, content: "拆句" }];

describe("callLlmJson 降级链", () => {
  beforeEach(() => {
    resetRungCache();
    MockChatOpenAI.mockReset();
  });

  it("json_schema 成功时不降级", async () => {
    stubModel([{ structured: async () => ({ statements: [] }) }]);

    await expect(callLlmJson(messages)).resolves.toEqual({ statements: [] });
    expect(MockChatOpenAI).toHaveBeenCalledTimes(1);
  });

  it("json_schema 不支持时降级到 json_object（第 2 档）", async () => {
    stubModel([
      {
        structured: async () =>
          Promise.reject(new Error("LLM HTTP 400: response_format unsupported")),
      },
      { invoke: async () => ({ content: '{"a":1}' }) },
    ]);

    await expect(callLlmJson(messages)).resolves.toEqual({ a: 1 });
    expect(MockChatOpenAI).toHaveBeenCalledTimes(2);
  });

  it("前两档都失败时降级到纯文本，并用括号配对提取", async () => {
    stubModel([
      {
        structured: async () =>
          Promise.reject(new Error("LLM HTTP 400: response_format unsupported")),
      },
      { invoke: async () => Promise.reject(new Error("LLM HTTP 400: json_object unsupported")) },
      { invoke: async () => ({ content: '好的：\n```json\n{"a":1}\n```' }) },
    ]);

    await expect(callLlmJson(messages)).resolves.toEqual({ a: 1 });
    // 依次尝试 jsonSchema → jsonObject → text
    expect(MockChatOpenAI).toHaveBeenCalledTimes(3);
  });

  it("成功后缓存档位：同一模型后续句子直达，不再先失败一次", async () => {
    stubModel([
      { structured: async () => Promise.reject(new Error("LLM HTTP 400: bad schema")) },
      { invoke: async () => Promise.reject(new Error("LLM HTTP 400: no json_object")) },
      { invoke: async () => ({ content: '{"a":2}' }) },
    ]);

    await expect(callLlmJson(messages)).resolves.toEqual({ a: 2 });
    expect(MockChatOpenAI).toHaveBeenCalledTimes(3);
    MockChatOpenAI.mockClear();

    mockTextOnly();
    await expect(callLlmJson(messages)).resolves.toEqual({ a: 3 });
    expect(MockChatOpenAI).toHaveBeenCalledTimes(1);
  });

  it("超时直接失败，不降级重试", async () => {
    const timeout = Object.assign(new Error("Body Timeout Error"), { name: "TimeoutError" });
    stubModel([{ structured: async () => Promise.reject(timeout) }]);

    await expect(callLlmJson(messages)).rejects.toThrow(/响应超时/);
    expect(MockChatOpenAI).toHaveBeenCalledTimes(1);
  });

  it("云端审核拦截直接失败，不降级重试", async () => {
    stubModel([
      { structured: async () => Promise.reject(new Error("LLM HTTP 400: DataInspectionFailed")) },
    ]);

    await expect(callLlmJson(messages)).rejects.toThrow(/云端内容审核拦截/);
    expect(MockChatOpenAI).toHaveBeenCalledTimes(1);
  });

  it("三档全失败时抛出汇总错误", async () => {
    stubModel([
      { structured: async () => Promise.reject(new Error("LLM HTTP 400: nope")) },
      { invoke: async () => Promise.reject(new Error("LLM HTTP 400: nope")) },
    ]);

    await expect(callLlmJson(messages)).rejects.toThrow(/已尝试全部降级方式/);
  });

  it("内容为空时继续降级（视为该档不可用）", async () => {
    stubModel([
      { structured: async () => "" },
      { invoke: async () => ({ content: "" }) },
      { invoke: async () => ({ content: '{"ok":true}' }) },
    ]);

    await expect(callLlmJson(messages)).resolves.toEqual({ ok: true });
  });
});

function mockTextOnly() {
  MockChatOpenAI.mockImplementation(() => ({
    withStructuredOutput: jest.fn(() => ({ invoke: async () => ({}) })),
    invoke: async () => ({ content: '{"a":3}' }),
  }));
}
