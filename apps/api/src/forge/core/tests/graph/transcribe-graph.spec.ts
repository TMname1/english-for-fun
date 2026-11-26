import type { TranscribeArtifactSource } from "../../graph/transcribe-artifacts";
import { buildTranscribeGraph } from "../../graph/transcribe-build";

function fakeArtifacts(calls: string[], failOn?: string): TranscribeArtifactSource {
  const guard = (name: string) => {
    calls.push(name);
    if (failOn === name) throw new Error(`[stub] ${name} 失败`);
  };
  return {
    async asrSentence() {
      guard("asrSentence");
      return { unitCount: 1 };
    },
    async processingAudio() {
      guard("processingAudio");
      return { chunkCount: 2 };
    },
    async asrWord() {
      guard("asrWord");
      return { segmentCount: 3, wordLevel: true, chunkDone: 2 };
    },
  };
}

describe("transcribe 子图", () => {
  it("拓扑顺序为 asrSentence → processingAudio → asrWord", async () => {
    const calls: string[] = [];
    const graph = buildTranscribeGraph({
      emitStage: () => {},
      artifacts: fakeArtifacts(calls),
    }).compile();

    const out = await graph.invoke({ outDir: "D:/tmp/out" });
    expect(calls).toEqual(["asrSentence", "processingAudio", "asrWord"]);
    expect(out.segmentCount).toBe(3);
    expect(out.wordLevel).toBe(true);
    expect(out.chunkCount).toBe(2);
  });

  it("任一节点抛错时整张子图 reject（不吞错）", async () => {
    const calls: string[] = [];
    const graph = buildTranscribeGraph({
      emitStage: () => {},
      artifacts: fakeArtifacts(calls, "asrWord"),
    }).compile();

    await expect(graph.invoke({ outDir: "D:/tmp/out" })).rejects.toThrow(/asrWord 失败/);
    expect(calls).toEqual(["asrSentence", "processingAudio", "asrWord"]);
  });
});
