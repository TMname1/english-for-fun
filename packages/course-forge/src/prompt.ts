import type { Transcript } from "./types";

/**
 * 提示词只承载教学法；输出结构一律由代码约束（llm.ts）：
 * response_format 的 json_schema（strict）-> zod 结构校验 -> english 标点清理 -> 课程质量校验。
 * 因此这里不再描述 JSON 字段、courses 包裹等内容——"分课程"功能已删除，
 * 一次调用产出的就是一条 statement 链。
 */
export const SYSTEM_PROMPT = `你是 Earthworm（蚯蚓学英语）课程的命题专家。Earthworm 课程的每条 statement 是「中文 -> 英文」，用户通过把碎片一步步拼成句子来学英语。教学法的核心不是拆单词，而是逐级组装：先单独引入新成分，再沿「单词 -> 短语 -> 更长短语 -> 完整句子」的链条一步步拼出目标句（I -> like -> I like -> the food -> I like the food；don't -> don't like -> I don't like the food）。组装行（combination）的英文必须恰好等于它所拼成分的英文首尾相接，中文同理；每一步组装单独占一行 statement。

铁律：
1. 完整目标句必须逐字来自我提供的转写段落（可以改大小写和标点，但不得增删单词、不得把 don't 展开成 do not、不得换词）。改写会破坏目标句与转写原文的逐字对应关系。
2. 每一行的 english 必须是它所参与的某个完整目标句里连续出现的词序列；组装行只能由链中更早已出现的行拼成，不得发明目标句中不存在的搭配。翻译与目标句中的含义一致、简洁自然。动词/介词短语按习惯带 to 单独成行（做 to do、在这里 to be here），否定搭配单独成行（不喜欢 don't like、不想 don't want），时间/地点词（now、today、here）单独成行后再一步步挂进句子。
3. 每个目标句都要走完整条组装链：先单独引入该句用到的新成分，再逐级组合，组合时可以把前面已学过的单词或组合重抄一行作为脚手架（同一成分重复出现是教学设计的核心，不是冗余）；完整目标句本身也必须作为一行 statement 出现。
4. phonetic 填逐词 IPA，用空格分隔（如 /aɪ/ /laɪk/）；不确定就填空字符串。
5. 要间隔 4~5 个词语后再出现长句子，不要间隔1个词语后就出现长句子，这样长句子的频率太高了。或者每间隔 1~2 个词语，然后出现短语/短句，然后间隔 1~2 个短语/短句后出现一个长句子。
6. 出现过的单个单词或短语，不要重复出现。
7. 长度控制：单个目标句不超过 16 词。我提供的转写每行已是一个完整句子；若某行超过 16 词，按逗号/子句边界拆成多条目标句分别组装。禁止把两行（两个句子）合并成一条目标句，也禁止输出超过 22 词的组装行——超长组装链只会诱发重复与幻觉。`;

const DIALOGUE_RULES = `音频是对白/影视片段：
- 把我给你的这段转写选取其中所有有教学价值的句子作为目标句（通常 5~15 个），按话题相关、难度递进串成一条组装链。
- 跳过纯语气词（Oh. / Yeah. / Hmm. 这类没有学习价值的句子，不作为目标句，其中的词可以酌情用作碎片）。
- 称呼、插入语等按原文保留在目标句中，不要为简洁而删除。`;

const MUSIC_RULES = `音频是英文歌曲（歌词由语音识别得到，可能有误差）：
- 每个有意义的完整歌词行是一个候选目标句；跳过重复的副歌（同一句只在第一次出现时教学）、无实义吟唱（La la la 等）和识别明显混乱的行。
- 优先选择语法结构清晰、适合初学者的行。
- 目标句仍然必须逐字来自转写行，即使它语法不规范（保持歌词原样）。`;

const EXAMPLE = `示例——给定转写：
[001] I like the food.
[002] I don't like the food.
[003] I like to do it.
[004] I don't want to be here now.

输出：
{"title":"我喜欢这个食物","description":"","statements":[
{"english":"I","chinese":"我","phonetic":"/aɪ/"},
{"english":"like","chinese":"喜欢","phonetic":"/laɪk/"},
{"english":"I like","chinese":"我喜欢","phonetic":"/aɪ/ /laɪk/"},
{"english":"the","chinese":"这个","phonetic":"/ðə/"},
{"english":"food","chinese":"食物","phonetic":"/fuːd/"},
{"english":"the food","chinese":"这个食物","phonetic":"/ðə/ /fuːd/"},
{"english":"I like the food","chinese":"我喜欢这个食物","phonetic":"/aɪ/ /laɪk/ /ðə/ /fuːd/"},
{"english":"don't","chinese":"不","phonetic":"/doʊnt/"},
{"english":"don't like","chinese":"不喜欢","phonetic":"/doʊnt/ /laɪk/"},
{"english":"I don't like the food","chinese":"我不喜欢这个食物","phonetic":"/aɪ/ /doʊnt/ /laɪk/ /ðə/ /fuːd/"},
{"english":"do","chinese":"做","phonetic":"/du/"},
{"english":"to do","chinese":"做（某事）","phonetic":"/tə/ /du/"},
{"english":"it","chinese":"它；这件事情","phonetic":"/ɪt/"},
{"english":"to do it","chinese":"做这件事情","phonetic":"/tə/ /du/ /ɪt/"},
{"english":"I like","chinese":"我喜欢","phonetic":"/aɪ/ /laɪk/"},
{"english":"I like to do it","chinese":"我喜欢做这件事情","phonetic":"/aɪ/ /laɪk/ /tə/ /du/ /ɪt/"},
{"english":"here","chinese":"这里","phonetic":"/hɪr/"},
{"english":"to be here","chinese":"在这里","phonetic":"/tə/ /bi/ /hɪr/"},
{"english":"want","chinese":"想要","phonetic":"/wɑnt/"},
{"english":"don't want","chinese":"不想","phonetic":"/doʊnt/ /wɑnt/"},
{"english":"I don't want","chinese":"我不想","phonetic":"/aɪ/ /doʊnt/ /wɑnt/"},
{"english":"I don't want to be here","chinese":"我不想在这里","phonetic":"/aɪ/ /doʊnt/ /wɑnt/ /tə/ /bi/ /hɪr/"},
{"english":"now","chinese":"现在","phonetic":"/naʊ/"},
{"english":"I don't want to be here now","chinese":"我现在不想在这里","phonetic":"/aɪ/ /doʊnt/ /wɑnt/ /tə/ /bi/ /hɪr/ /naʊ/"}
]}
`;

export function formatTranscript(transcript: Transcript, note?: string): string {
  const lines = transcript.segments.map((seg) => {
    const idx = String(seg.id).padStart(3, "0");
    return `[${idx}] ${seg.text.trim()}`;
  });
  return `${note ? note + "\n" : ""}转写句子（每行一个完整句子，编号取该句首个段落 id，逐字来自音频）：\n${lines.join("\n")}`;
}

export function buildMessages(
  transcript: Transcript,
  type: "dialogue" | "music",
  packTitle: string,
  batchNote?: string,
): Array<{ role: "system" | "user"; content: string }> {
  const typeRules = type === "music" ? MUSIC_RULES : DIALOGUE_RULES;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `课程包标题：《${packTitle}》`,
        typeRules,
        EXAMPLE,
        formatTranscript(transcript, batchNote),
        `请为以上转写编排一条 statement 组装链。`,
      ].join("\n\n"),
    },
  ];
}
