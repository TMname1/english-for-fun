/**
 * 一句一调用的提示词：模型只拿到【编号词表】，只回词编号，
 * english 由代码按编号还原（见 llm.ts 的 cleanWordToken / buildEnglishFromIndexes）。
 * 结构约束（json_schema + zod + validateRowIndexes）由代码承担，
 * 这里保留教学法（六步拆句：谓语 → 主干 → 从句 → 非谓语 → 修饰/插入 → 翻译整句）、
 * 一条正例和一条反例，尽量精简——一次课程会发起与句子数等量的模型调用。
 */
export const SYSTEM_PROMPT = `你在为「蚯蚓学英语」把【一句英文】做成组装链：先把这句拆成短语碎片，再沿「短语 → 整句」一步步拼回这句完整的话，让用户学会拼出它。

输入是一份【编号词表】：每行「编号 词」，编号从 0 开始，把词按编号顺序拼起来就是这句原句。
你只输出词编号，绝不输出英文单词文本——english 由代码按编号还原，因此不存在改写或漏词的可能。

最高优先级：statements 的最后一行必须是这一整句——indexes 恰为 0,1,…,N-1（顺序不变、一个都不少），chinese 是整句翻译。无论句子多长、结构多复杂，这一行都不能少。只输出碎片、没有整句行，就是不合格输出，会被打回重做。

拆解句子时按以下步骤在内部完成（只用于决定怎么切碎片，不要把步骤文字写进输出）：
1. 找谓语：先找句子中真正的谓语动词，分清主句谓语、从句谓语和非谓语形式。
2. 找主干：找出主语、谓语、宾语或表语，先确定这句话的核心意思。
3. 找从句：判断定语从句、状语从句、名词性从句，并划出各自的范围。
4. 找非谓语：分析 to do、doing、done 在句中作什么成分（主语、宾语、定语、状语或补语）。
5. 找修饰和插入成分：把剩余的定语、状语、同位语、插入语归类，理清它们修饰谁、逻辑关系是什么。
6. 翻译整句：先翻译主干，再把从句、非谓语和修饰信息按中文逻辑组合进去，得到整句翻译。
7. 人名不要翻译，中文和英文都用原文。

按上述分析组织组装链：先给主干与各类成分的碎片（短语或从句片段），再逐步组合成更长的片段，最后一行收束为整句。

铁律：
1. 每行的 indexes 必须是词编号组成的升序连续整数区间（如 [4,5,6]），不得跳号、重复、倒序，行内不得为空。
2. 每行只能取原句里连续出现的词：编号必须连号，不能把不相邻的词拼在同一行。
3. 必须有一行（放在最后）indexes 恰为 0,1,…,N-1；长难句也要完整保留，不得因为长就省略从句或修饰成分。
4. 不要逐词成行，也不要只给整句：按语义切成短语/从句片段再组合，每行 indexes 至少 2 个词（本句只有 1 个词时除外），整条链控制在 4–10 行左右。
5. phonetic 按该行对应的词逐个给 IPA，用空格分隔（如 /aɪ/ /laɪk/）；不确定就填空字符串 ""。
6. chinese 给该行英文片段的简洁自然中文翻译，不要加引号。
7. 只输出 JSON，不要输出任何解释文字。

示例——词表：
0 I
1 like
2 the
3 food.
输出：
{"statements":[
{"indexes":[2,3],"chinese":"这个食物","phonetic":"/ðə/ /fuːd/"},
{"indexes":[0,1],"chinese":"我喜欢","phonetic":"/aɪ/ /laɪk/"},
{"indexes":[0,1,2,3],"chinese":"我喜欢这个食物","phonetic":"/aɪ/ /laɪk/ /ðə/ /fuːd/"}
]}

不合格示例——同样输入：
输出：{"statements":[
{"indexes":[0],"chinese":"我","phonetic":"/aɪ/"},
{"indexes":[1],"chinese":"喜欢","phonetic":"/laɪk/"},
{"indexes":[2,3],"chinese":"这个食物","phonetic":"/ðə/ /fuːd/"}
]}
（不合格：只是逐词表和碎片，没有 indexes 恰为 [0,1,2,3] 的整句行，同时把每个词单独成行）`;

/** 编号词表：每行「编号 词」，比 JSON 形式省 60% token，且模型不需要数括号 */
export function formatNumberedWords(words: string[]): string {
  return words.map((w, i) => `${i} ${w}`).join("\n");
}

export function buildMessages(
  words: string[],
  note?: string,
): Array<{ role: "system" | "user"; content: string }> {
  const last = words.length - 1;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `请把下面这句英文拆成碎片并逐级拼回完整原句，输出组装链。\n` +
        `本句词表（共 ${words.length} 个词，编号 0..${last}，格式「编号 词」，词表按顺序拼起来就是这句原句）：\n` +
        `${formatNumberedWords(words)}\n` +
        `要求：只能用这些编号引用词，不要输出英文单词文本；最后一行 indexes 必须恰为 0,1,…,${last}。` +
        (note ? `\n\n${note}` : ""),
    },
  ];
}
