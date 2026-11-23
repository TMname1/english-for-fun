<template>
  <div class="space-y-4">
    <p class="text-sm opacity-70">
      {{ failures.length }}
      个句子未通过校验。对每个句子选择「重试该句」（再生成一次）、「删除该句」（从课程中省略），或「删除所有单个单词」（丢掉这句输出里的单词行，剩余内容重新校验）。
    </p>

    <div
      class="max-h-[60vh] space-y-3 overflow-auto rounded border border-gray-200 p-3 dark:border-gray-700"
    >
      <div
        v-for="f in failures"
        :key="f.index"
        class="rounded border border-gray-100 p-3 dark:border-gray-700"
      >
        <div class="mb-1 flex items-center justify-between text-xs opacity-70">
          <span> #{{ f.index + 1 }} </span>
          <span class="truncate">原句：{{ f.sentence }}</span>
        </div>

        <div class="mb-2 rounded bg-gray-50 p-2 text-sm dark:bg-gray-800">
          <span class="font-medium">要求的输出（原句）：</span>
          <code class="break-all">{{ f.sentence }}</code>
        </div>

        <details class="mb-2">
          <summary class="cursor-pointer text-xs opacity-70">失败原因</summary>
          <ul class="mt-1 list-disc pl-5 text-xs opacity-80">
            <li
              v-for="(a, ai) in f.attempts"
              :key="ai"
            >
              第 {{ ai + 1 }} 次：{{ a.reason }}
            </li>
          </ul>
        </details>

        <div
          v-if="hasOutput(f)"
          class="mb-2"
        >
          <div class="mb-1 text-xs font-medium opacity-70">模型最近一次输出：</div>
          <table
            v-if="displayStatements(f).length"
            class="w-full text-xs"
          >
            <thead class="text-left opacity-70">
              <tr>
                <th class="px-1 py-0.5">english</th>
                <th class="px-1 py-0.5">chinese</th>
                <th class="px-1 py-0.5">phonetic</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(s, si) in displayStatements(f)"
                :key="si"
                class="border-t border-gray-100 dark:border-gray-700"
              >
                <td class="break-all px-1 py-0.5">{{ s.english }}</td>
                <td class="break-all px-1 py-0.5">{{ s.chinese }}</td>
                <td class="break-all px-1 py-0.5">{{ s.phonetic }}</td>
              </tr>
            </tbody>
          </table>
          <details v-if="displayRaw(f)">
            <summary class="cursor-pointer text-xs opacity-70">原始返回（JSON）</summary>
            <pre class="mt-1 overflow-auto rounded bg-gray-100 p-2 text-xs dark:bg-gray-800">{{
              displayRaw(f)
            }}</pre>
          </details>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <UButton
            size="xs"
            :color="decisionOf(f.index) === 'retry' ? 'violet' : 'gray'"
            variant="soft"
            :disabled="submitting"
            @click="choose(f.index, 'retry')"
          >
            重试该句
          </UButton>
          <UButton
            size="xs"
            :color="decisionOf(f.index) === 'delete' ? 'red' : 'gray'"
            variant="soft"
            :disabled="submitting"
            @click="askDelete(f.index)"
          >
            删除该句
          </UButton>
          <UButton
            size="xs"
            :color="decisionOf(f.index) === 'strip_words' ? 'amber' : 'gray'"
            variant="soft"
            :disabled="submitting || singleWordCount(f) === 0"
            :title="
              singleWordCount(f) === 0
                ? '这句的最近一次输出里没有单个单词的行'
                : '删掉这句输出里所有只有一个词的行，剩下的内容重新校验，合格就直接通过'
            "
            @click="choose(f.index, 'strip_words')"
          >
            删除所有单个单词{{ singleWordCount(f) > 0 ? `（${singleWordCount(f)}）` : "" }}
          </UButton>
          <span
            v-if="decisionOf(f.index) === 'strip_words'"
            class="text-xs opacity-70"
          >
            将删除
            {{ singleWordCount(f) }} 个单词行，剩余内容重新校验：合格即通过，不合格还要你再选一次。
          </span>
          <span
            v-if="confirmIndex === f.index"
            class="text-xs text-red-500"
          >
            确认删除？该句将不会出现在课程中。
          </span>
          <template v-if="confirmIndex === f.index">
            <UButton
              size="xs"
              color="red"
              :disabled="submitting"
              @click="confirmDelete(f.index)"
            >
              确认
            </UButton>
            <UButton
              size="xs"
              color="gray"
              variant="ghost"
              :disabled="submitting"
              @click="confirmIndex = null"
            >
              取消
            </UButton>
          </template>
        </div>
      </div>
    </div>

    <p
      v-if="!canSubmit && failures.length > 0"
      class="text-xs text-red-500"
    >
      {{
        remainingEstimate === 0
          ? "所有句子都被删除后无法生成课程，请至少保留一句。"
          : "请为每个失败句子选择一个处理方式。"
      }}
    </p>

    <div class="flex justify-end gap-2 pt-2">
      <UButton
        color="gray"
        variant="ghost"
        :disabled="submitting"
        @click="emit('cancel')"
      >
        取消
      </UButton>
      <UButton
        :loading="submitting"
        :disabled="!canSubmit"
        @click="handleResolve"
      >
        应用并继续
      </UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { toast } from "vue-sonner";

import type {
  ForgeJobCourseStatement,
  ForgeJobView,
  ForgeSentenceAttempt,
  ForgeStructureFailure,
  ResolveForgeFailuresDecision,
} from "~/api/forge";

const props = defineProps<{ job: ForgeJobView }>();
const emit = defineEmits<{
  (e: "resolve", decisions: ResolveForgeFailuresDecision[]): void;
  (e: "cancel"): void;
}>();

const submitting = ref(false);
const confirmIndex = ref<number | null>(null);
type Decision = ResolveForgeFailuresDecision["action"];
const decisions = ref<Record<number, Decision>>({});

const failures = computed<ForgeStructureFailure[]>(
  () => props.job.structureProgress?.failures ?? [],
);
const successCount = computed(() => props.job.structureProgress?.success.length ?? 0);
/** 选择「重试」或「删除所有单个单词」都可能让该句进课程，因此都算保留 */
const keepCount = computed(
  () =>
    failures.value.filter((f) => {
      const d = decisions.value[f.index];
      return d === "retry" || d === "strip_words";
    }).length,
);
const allDecided = computed(() =>
  failures.value.every(
    (f) =>
      decisions.value[f.index] === "delete" ||
      decisions.value[f.index] === "retry" ||
      decisions.value[f.index] === "strip_words",
  ),
);
const remainingEstimate = computed(() => successCount.value + keepCount.value);
const canSubmit = computed(
  () =>
    failures.value.length > 0 &&
    allDecided.value &&
    remainingEstimate.value > 0 &&
    !submitting.value,
);

function decisionOf(index: number): Decision | undefined {
  return decisions.value[index];
}

function latestOf(f: ForgeStructureFailure): ForgeSentenceAttempt | null {
  return f.attempts[f.attempts.length - 1] ?? null;
}

function hasOutput(f: ForgeStructureFailure): boolean {
  const a = latestOf(f);
  return Boolean(a && (a.statements?.length || a.raw));
}

function displayStatements(f: ForgeStructureFailure): ForgeJobCourseStatement[] {
  return latestOf(f)?.statements ?? [];
}

function displayRaw(f: ForgeStructureFailure): string {
  return latestOf(f)?.raw ?? "";
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** 从最近一次原始输出里取回行编号（模型只回 indexes）；有任何一行不合规就返回 null */
function rawRowsOf(f: ForgeStructureFailure): Array<{ indexes: number[] }> | null {
  const text = displayRaw(f);
  if (!text) return null;
  try {
    let parsed: unknown = JSON.parse(text);
    const wrapped = parsed as { courses?: unknown };
    if (wrapped && Array.isArray(wrapped.courses)) parsed = wrapped.courses[0];
    const rows = (parsed as { statements?: unknown })?.statements;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const valid = rows.every(
      (r) =>
        Array.isArray((r as { indexes?: unknown })?.indexes) &&
        (r as { indexes: unknown[] }).indexes.length > 0,
    );
    return valid ? (rows as Array<{ indexes: number[] }>) : null;
  } catch {
    return null;
  }
}

/**
 * 该句最近一次输出里「单词成行」的行数（与后端 validateRowIndexes 同一口径：
 * 本句只有 1 个词时整句行本身就是单词行，不算违规，也不删）。
 */
function singleWordCount(f: ForgeStructureFailure): number {
  if (countWords(f.sentence) <= 1) return 0;
  const rows = rawRowsOf(f);
  if (rows) return rows.filter((r) => r.indexes.length === 1).length;
  // 原始输出解析不出编号时，退回按 english 词数估算
  return displayStatements(f).filter((s) => countWords(s.english) === 1).length;
}

function choose(index: number, action: Decision) {
  confirmIndex.value = null;
  decisions.value[index] = action;
}

function askDelete(index: number) {
  if (decisions.value[index] === "delete") return;
  confirmIndex.value = index;
}

function confirmDelete(index: number) {
  decisions.value[index] = "delete";
  confirmIndex.value = null;
}

function handleResolve() {
  if (!canSubmit.value) {
    toast.error("请先为每个失败句子选择处理方式");
    return;
  }
  const payload: ResolveForgeFailuresDecision[] = failures.value.map((f) => ({
    index: f.index,
    action: decisions.value[f.index],
  }));
  submitting.value = true;
  emit("resolve", payload);
}
</script>
