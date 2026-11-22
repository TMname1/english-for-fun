<template>
  <div class="space-y-4">
    <p class="text-sm opacity-70">
      {{
        failures.length
      }}
      个句子未通过校验。对每个句子选择「删除该句」（从课程中省略）或「重试该句」（再生成一次）。
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

        <div class="flex items-center gap-2">
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
const decisions = ref<Record<number, "delete" | "retry">>({});

const failures = computed<ForgeStructureFailure[]>(
  () => props.job.structureProgress?.failures ?? [],
);
const successCount = computed(() => props.job.structureProgress?.success.length ?? 0);
const retryCount = computed(
  () => failures.value.filter((f) => decisions.value[f.index] === "retry").length,
);
const allDecided = computed(() =>
  failures.value.every(
    (f) => decisions.value[f.index] === "delete" || decisions.value[f.index] === "retry",
  ),
);
const remainingEstimate = computed(() => successCount.value + retryCount.value);
const canSubmit = computed(
  () =>
    failures.value.length > 0 &&
    allDecided.value &&
    remainingEstimate.value > 0 &&
    !submitting.value,
);

function decisionOf(index: number): "delete" | "retry" | undefined {
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

function choose(index: number, action: "delete" | "retry") {
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
