/**
 * 一句一调用的提示词：把单个转写句子拆成碎片、再逐级拼回完整原句。
 * 输出结构由代码约束（llm.ts 的 json_schema + zod + 完整原句锚点校验），
 * 这里只保留教学法与一条短示例，尽量精简——一次课程会发起与句子数等量的模型调用。
 */
export const SYSTEM_PROMPT = `你在为「蚯蚓学英语」把【一句英文】做成组装链：先把这句拆成单词和短语碎片，再沿「词 → 短语 → 整句」一步步拼回这句完整的话，让用户学会拼出它。

铁律：
1. 只能拆分与组合，绝不能改写任何一个词：保留原句里的缩写（we're、i'll、don't…），不得展开成 we are / do not，不得增删词、不得换词；只允许调整大小写和标点。
2. 每一行的 english 必须是原句里连续出现的词序列；组合行的英文 = 它所用碎片逐字首尾相接的结果。
3. 输出必须包含逐字等于这句完整原句的一行（作为最后一行），一个词都不能丢。
4. 每一行至少要有一个实词：不要输出只有标点（如 ","、"?"）的行，标点应附着在它前面的词上。
5. phonetic 填逐词 IPA，用空格分隔（如 /aɪ/ /laɪk/）；不确定就填空字符串 ""。
6. chinese 给该英文片段简洁自然的中文翻译。

示例——输入：I like the food.
输出：
{"statements":[
{"english":"I","chinese":"我","phonetic":"/aɪ/"},
{"english":"like","chinese":"喜欢","phonetic":"/laɪk/"},
{"english":"the food","chinese":"这个食物","phonetic":"/ðə/ /fuːd/"},
{"english":"I like","chinese":"我喜欢","phonetic":"/aɪ/ /laɪk/"},
{"english":"I like the food","chinese":"我喜欢这个食物","phonetic":"/aɪ/ /laɪk/ /ðə/ /fuːd/"}
]}`;

export function buildMessages(
  sentence: string,
  note?: string,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `请把下面这句英文拆成碎片并逐级拼回完整原句，输出组装链。\n原句：${sentence.trim()}${
        note ? `\n\n${note}` : ""
      }`,
    },
  ];
}
