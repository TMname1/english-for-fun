/**
 * 阶段事件发射器：把图节点里的阶段变化映射成现有的 stdout JSON Lines `{event:"stage"}`。
 *
 * 为什么不用 `graph.stream({streamMode:"updates"})` 反推阶段：`transcribe` 子图的 `asrSentence`
 * 内要先后发 `transcoding` → `transcribing`（而且按 unit 逐个发），节点级更新表达不了；
 * 而且 resume 时节点顺序与真实阶段顺序不一定一致。闭包注入的 emitter 在 invoke/stream 下
 * 行为一致，也便于测试。
 */
import type { ForgeStage } from "../forge";

/** 单调序号：只允许阶段前进（structuring 例外，resolve 轮次会再次进入） */
const ORDER: Record<ForgeStage, number> = {
  transcoding: 1,
  transcribing: 2,
  transcribed: 3,
  structuring: 4,
  aligning: 5,
  done: 6,
};

export type StageEmitter = (stage: ForgeStage) => void;

export function createStageEmitter(sink: (stage: ForgeStage) => void): StageEmitter {
  let last = 0;
  return (stage) => {
    if (stage !== "structuring" && ORDER[stage] <= last) return;
    last = Math.max(last, ORDER[stage]);
    sink(stage);
  };
}
