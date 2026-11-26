/**
 * 渲染守卫：提示词正文现在由 `@langfuse/client` 的 `TextPromptClient.compile`（Mustache）渲染。
 *
 * 这里用**真实的 SDK 类**渲染两份本地兜底常量，锁住三件事：
 *   1. 变量确实被替换、没有残留 `{{`；
 *   2. 正文没有 Mustache 控制语法（section/partial/triple/delimiter），否则线上会被适配器拒绝回退；
 *   3. 变量值里的 `& < > "` 与 JSON 花括号原样保留（SDK 全局关掉了 HTML 转义）。
 *
 * 任一断言失败，说明「代码里的兜底」与「Langfuse 里期望的模板形态」已经漂移。
 */
import {
  buildPreprocessVars,
  PREPROCESS_PROMPT_VARS,
  PREPROCESS_SYSTEM_PROMPT,
} from "../preprocess";
import { buildSentenceVars, SENTENCE_PROMPT_VARS, SYSTEM_PROMPT } from "../prompt";
import { compilePrompt, findPromptVars } from "../prompt-store";

const MUSTACHE_CONTROL_RE = /\{\{\{|\{\{\s*[#^/>!={&]/;

function collect(source: string): string[] {
  return [...new Set(findPromptVars(source))].sort();
}

describe("本地兜底提示词的 Mustache 渲染", () => {
  it("句子链：变量全部替换，权威中文与词表都进正文", () => {
    const text = compilePrompt(
      SYSTEM_PROMPT,
      buildSentenceVars(["I", "like", "the", "food."], "我喜欢这个食物。"),
    );

    expect(text).not.toContain("{{");
    expect(text).toContain("共 4 个词，编号 0..3");
    expect(text).toContain("3 food.");
    expect(text).toContain("【本句权威中文】我喜欢这个食物。");
  });

  it("句子链：没有句级中文时渲染成哨兵「（无）」，提示词仍可无条件判断", () => {
    const text = compilePrompt(SYSTEM_PROMPT, buildSentenceVars(["Hi"]));
    expect(text).toContain("【本句权威中文】（无）");
    expect(text).not.toContain("{{");
  });

  it("拆句：转写、JSON 词表、重试诊断都进正文", () => {
    const words = [
      { word: { word: "I", start: 0, end: 0.2 }, attachToPrev: false },
      { word: { word: "like", start: 0.3, end: 0.5 }, attachToPrev: false },
    ];
    const text = compilePrompt(PREPROCESS_SYSTEM_PROMPT, buildPreprocessVars("I like", words));

    expect(text).not.toContain("{{");
    expect(text).toContain("整段文本：I like");
    expect(text).toContain('[{"i":0,"word":"I"},{"i":1,"word":"like"}]');
    expect(text).toContain("【重试诊断】（无）");
  });

  it("两份常量只含 {{变量}}，没有 Mustache 控制语法", () => {
    expect(SYSTEM_PROMPT).not.toMatch(MUSTACHE_CONTROL_RE);
    expect(PREPROCESS_SYSTEM_PROMPT).not.toMatch(MUSTACHE_CONTROL_RE);
  });

  it("常量里的变量集合与代码声明的必需变量一一对应", () => {
    expect(collect(SYSTEM_PROMPT)).toEqual([...SENTENCE_PROMPT_VARS].sort());
    expect(collect(PREPROCESS_SYSTEM_PROMPT)).toEqual([...PREPROCESS_PROMPT_VARS].sort());
  });

  it("变量值原样插入：JSON 花括号与 & < > 不被转义、不被二次渲染", () => {
    const value = '[{"i":0,"word":"a&b<c>\\"d\\""}] {{who}}';
    expect(compilePrompt("前缀{{words}}后缀", { words: value })).toBe(`前缀${value}后缀`);
  });
});
