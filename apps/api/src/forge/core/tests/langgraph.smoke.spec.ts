/**
 * LangGraph 运行时冒烟：只验证「在当前 Node / CJS 环境下这把锁能开」，
 * 不涉及 forge 业务。任何一条断言失败，说明依赖升级或 Node 基线变化破坏了
 * `core/graph/*` 的前提（详见 plan 第 8 节验证清单）。
 */
import {
  Annotation,
  Command,
  END,
  interrupt,
  isInterrupted,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import {
  BaseCheckpointSaver,
  JsonPlusSerializer,
  WRITES_IDX_MAP,
} from "@langchain/langgraph-checkpoint";

describe("langgraph 运行时契约", () => {
  it("CJS 入口导出编排所需 API", () => {
    expect(typeof StateGraph).toBe("function");
    expect(typeof Annotation.Root).toBe("function");
    expect(typeof Command).toBe("function");
    expect(typeof interrupt).toBe("function");
    expect(typeof isInterrupted).toBe("function");
    expect(typeof MemorySaver).toBe("function");
    expect(START).toBe("__start__");
    expect(END).toBe("__end__");
  });

  it("checkpoint 包导出 BaseCheckpointSaver / WRITES_IDX_MAP", () => {
    expect(typeof BaseCheckpointSaver).toBe("function");
    // 特殊 channel 的写入下标必须是负值，saver 的 putWrites 依赖它
    expect(WRITES_IDX_MAP.__interrupt__).toBeLessThan(0);
    expect(typeof new JsonPlusSerializer().dumpsTyped).toBe("function");
  });

  it("interrupt + Command({resume}) 能暂停并从断点续跑", async () => {
    const State = Annotation.Root({
      value: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
      resumed: Annotation<string | null>({ reducer: (_prev, next) => next, default: () => null }),
    });

    const graph = new StateGraph(State)
      .addNode("work", async () => ({ value: 7 }))
      .addNode("gate", async (state) => {
        // resume 会从该节点开头重放，因此 interrupt 之前不能有副作用
        const decision = interrupt({ value: state.value });
        return { resumed: String(decision) };
      })
      .addEdge(START, "work")
      .addEdge("work", "gate")
      .addEdge("gate", END)
      .compile({ checkpointer: new MemorySaver() });

    const config = { configurable: { thread_id: "smoke" } };
    const paused = await graph.invoke({ value: 0 }, config);
    expect(isInterrupted(paused)).toBe(true);
    expect((await graph.getState(config)).next).toEqual(["gate"]);

    const finished = await graph.invoke(new Command({ resume: "ok" }), config);
    expect(finished.resumed).toBe("ok");
  });

  it("withStructuredOutput 接受原生 JSON Schema（非 zod）", async () => {
    const { ChatOpenAI } = await import("@langchain/openai");
    const model = new ChatOpenAI({ model: "test-model", apiKey: "sk-test" });
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["statements"],
      properties: {
        statements: {
          type: "array",
          items: {
            type: "object",
            required: ["indexes"],
            properties: { indexes: { type: "array", items: { type: "integer" } } },
          },
        },
      },
    };
    const structured = model.withStructuredOutput(schema, {
      name: "structured_output",
      strict: true,
      method: "jsonSchema",
    });
    expect(typeof structured.invoke).toBe("function");
  });

  it("maxTokens 映射到 max_tokens（DashScope 只认这个字段）", async () => {
    const { ChatOpenAI } = await import("@langchain/openai");
    const model = new ChatOpenAI({ model: "test-model", apiKey: "sk-test", maxTokens: 1234 });
    const params = (await model.invocationParams({})) as { max_tokens?: number };
    expect(params.max_tokens).toBe(1234);
  });
});
