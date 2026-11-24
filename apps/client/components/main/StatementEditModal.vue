<template>
  <UModal
    v-model="showStatementEditModal"
    :prevent-close="isSaving"
  >
    <UContainer
      :ui="{
        base: 'w-[90vw] h-[85vh] flex flex-col py-6 text-gray-900 dark:text-white',
        constrained: 'max-w-[1100px] max-h-[85vh]',
      }"
    >
      <CommonModalHeader
        title="修改当前句子"
        @close="handleClose"
      />

      <div class="flex min-h-0 flex-1 flex-col gap-4">
        <p class="text-sm opacity-70">
          <template v-if="isLoading">正在载入当前句子……</template>
          <template v-else-if="editStatements.length > 0">
            正在修改第 {{ currentIndex + 1 }} /
            {{ editStatements.length }} 句；保存后本题会重新开始。
          </template>
        </p>

        <div class="min-h-0 flex-1 overflow-y-auto pr-1">
          <p
            v-if="loadError"
            class="text-sm text-red-500"
          >
            {{ loadError }}
          </p>

          <template v-else-if="!isLoading">
            <!-- 学习页的全局快捷键（空格/回车切题、Ctrl+p 暂停）挂在 window 上，
                 在输入框里打字时必须拦住冒泡，否则编辑句子会顺手切题 -->
            <div
              class="flex flex-col gap-4"
              @keydown.stop
            >
              <div class="flex flex-col gap-1">
                <label class="text-sm font-medium opacity-80">英文句子（必填）</label>
                <UTextarea
                  v-model="form.english"
                  :rows="3"
                  autoresize
                  placeholder="english"
                />
              </div>

              <div class="flex flex-col gap-1">
                <label class="text-sm font-medium opacity-80">中文释义（必填）</label>
                <UTextarea
                  v-model="form.chinese"
                  :rows="2"
                  autoresize
                  placeholder="chinese"
                />
              </div>

              <div class="flex flex-col gap-1">
                <label class="text-sm font-medium opacity-80">音标（可选）</label>
                <UInput
                  v-model="form.phonetic"
                  placeholder="phonetic"
                />
              </div>

              <div
                v-if="hasVideo"
                class="grid grid-cols-1 gap-3 sm:grid-cols-2"
              >
                <div class="flex flex-col gap-1">
                  <label class="text-sm font-medium opacity-80">视频开始时间（秒）</label>
                  <!-- 数字输入框回传的是 number，统一转成字符串，保证 form 类型一致 -->
                  <UInput
                    :model-value="form.startTime"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="开始时间(秒，可选)"
                    @update:model-value="
                      (v: string | number) => (form.startTime = toTimingInput(v))
                    "
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <label class="text-sm font-medium opacity-80">视频结束时间（秒）</label>
                  <UInput
                    :model-value="form.endTime"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="结束时间(秒，可选)"
                    @update:model-value="(v: string | number) => (form.endTime = toTimingInput(v))"
                  />
                </div>
              </div>

              <p
                v-if="englishChanged"
                class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-700 dark:border-amber-500/60 dark:bg-amber-500/10 dark:text-amber-300"
              >
                英文句子改动后，这句的逐词时间戳会失效（发音回退到合成的 TTS），
                且该句需要重新练习才能再次标记为已掌握。
              </p>

              <p
                v-if="errorMessage"
                class="text-sm text-red-500"
              >
                {{ errorMessage }}
              </p>
            </div>
          </template>
        </div>

        <div class="flex items-center justify-between gap-3 border-t pt-4 dark:border-gray-700">
          <p class="hidden text-xs opacity-60 sm:block">
            这里只编辑当前这一句，课程里其它句子不受影响。
          </p>
          <div class="flex gap-3">
            <UButton
              color="gray"
              variant="ghost"
              :disabled="isSaving"
              @click="handleClose"
            >
              取消
            </UButton>
            <UButton
              color="primary"
              :loading="isSaving"
              :disabled="isLoading || !!loadError"
              @click="handleSave"
            >
              保存并重做本题
            </UButton>
          </div>
        </div>
      </div>
    </UContainer>
  </UModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { toast } from "vue-sonner";

import type { CreateCoursePackStatement } from "~/api/course-pack";
import { fetchCoursePackForEdit, updateCoursePack } from "~/api/course-pack";
import CommonModalHeader from "~/components/common/ModalHeader.vue";
import { useQuestionInput } from "~/components/main/QuestionInput/questionInputHelper";
import { useGameMode } from "~/composables/main/game";
import { resetQuestionInput } from "~/composables/main/question";
import { useGamePause } from "~/composables/main/useGamePause";
import { useStatementEdit } from "~/composables/main/useStatementEdit";
import { useCourseStore } from "~/store/course";
import { useGameStore } from "~/store/game";

const courseStore = useCourseStore();
const gameStore = useGameStore();
const { focusInput } = useQuestionInput();
const { showQuestion } = useGameMode();
const { resumeGame, disableAutoPauseCheck } = useGamePause();
const { showStatementEditModal, closeStatementEditModal } = useStatementEdit();

const isLoading = ref(false);
const isSaving = ref(false);
const loadError = ref("");
const errorMessage = ref("");
/** /edit 返回的课程包元信息（video 为对象键/外链原文，保存时原样回传） */
const packMeta = ref({ title: "", description: "", cover: "", video: "" });
/** /edit 返回的全量句子：保存时整包回传，只替换当前这一条 */
const editStatements = ref<CreateCoursePackStatement[]>([]);
const currentIndex = ref(0);
const originalEnglish = ref("");
interface StatementForm {
  english: string;
  chinese: string;
  phonetic: string;
  /** 视频时间在表单里统一存字符串，保存时再解析成秒数 */
  startTime: string;
  endTime: string;
}

const form = ref<StatementForm>({
  english: "",
  chinese: "",
  phonetic: "",
  startTime: "",
  endTime: "",
});

/** 打开弹窗时是否由本弹窗暂停了游戏，只有自己暂停的才在关闭时恢复 */
let pausedByModal = false;

const hasVideo = computed(() => Boolean(courseStore.currentLearning?.video));
const englishChanged = computed(() => form.value.english.trim() !== originalEnglish.value.trim());

watch(showStatementEditModal, async (visible) => {
  if (visible) {
    pausedByModal = gameStore.pauseGame();
    if (pausedByModal) disableAutoPauseCheck();
    await loadCurrentStatement();
    return;
  }

  if (pausedByModal) {
    pausedByModal = false;
    resumeGame();
  }
  setTimeout(() => {
    focusInput();
  }, 300);
});

async function loadCurrentStatement() {
  errorMessage.value = "";
  loadError.value = "";

  const coursePackId = courseStore.currentLearning?.coursePackId;
  if (!coursePackId) {
    loadError.value = "课程数据尚未载入，请稍后再试";
    return;
  }

  isLoading.value = true;
  try {
    const data = await fetchCoursePackForEdit(coursePackId);
    editStatements.value = data.statements;
    packMeta.value = {
      title: data.title,
      description: data.description,
      cover: data.cover,
      video: data.video,
    };

    const index = resolveCurrentIndex(data.statements);
    currentIndex.value = index;

    const target = data.statements[index];
    if (!target) {
      loadError.value = "没有找到当前句子，可能课程已被修改";
      return;
    }

    originalEnglish.value = target.english;
    form.value = {
      english: target.english,
      chinese: target.chinese,
      phonetic: target.phonetic ?? "",
      startTime: toInputText(target.startTime),
      endTime: toInputText(target.endTime),
    };
  } catch (error: unknown) {
    const message = (error as { message?: string })?.message;
    loadError.value = message ? `载入失败：${message}` : "载入当前句子失败，请稍后再试";
  } finally {
    isLoading.value = false;
  }
}

/** 学习页的句子下标与 /edit 一致；若课程在别处被改过导致错位，退回按英文文本匹配 */
function resolveCurrentIndex(statements: CreateCoursePackStatement[]) {
  const fallback = Math.min(Math.max(courseStore.statementIndex, 0), statements.length - 1);
  const current = courseStore.currentStatement;
  if (!current) return fallback;

  const atIndex = statements[courseStore.statementIndex];
  if (atIndex && atIndex.english === current.english) return courseStore.statementIndex;

  const matched = statements.findIndex((item) => item.english === current.english);
  return matched !== -1 ? matched : fallback;
}

async function handleSave() {
  if (isSaving.value) return;
  errorMessage.value = "";

  const coursePackId = courseStore.currentLearning?.coursePackId;
  if (!coursePackId) {
    errorMessage.value = "课程数据尚未载入，请稍后再试";
    return;
  }

  const english = form.value.english.trim();
  const chinese = form.value.chinese.trim();
  if (!english) {
    errorMessage.value = "英文句子不能为空";
    return;
  }
  if (!chinese) {
    errorMessage.value = "中文释义不能为空";
    return;
  }

  const startTime = parseTiming(form.value.startTime);
  const endTime = parseTiming(form.value.endTime);
  if (startTime.invalid || endTime.invalid) {
    errorMessage.value = "视频时间必须是大于等于 0 的数字（单位：秒）";
    return;
  }
  if (
    hasVideo.value &&
    startTime.value !== undefined &&
    endTime.value !== undefined &&
    endTime.value <= startTime.value
  ) {
    errorMessage.value = "结束时间必须大于开始时间";
    return;
  }

  const nextStatement: CreateCoursePackStatement = {
    english,
    chinese,
    phonetic: form.value.phonetic.trim(),
  };
  if (hasVideo.value) {
    if (startTime.value !== undefined) nextStatement.startTime = startTime.value;
    if (endTime.value !== undefined) nextStatement.endTime = endTime.value;
  }

  // PATCH 会整包重建句子，所以回传全量列表，只替换当前这一条
  const statements = editStatements.value.map((item, index) =>
    index === currentIndex.value ? nextStatement : item,
  );

  isSaving.value = true;
  try {
    await updateCoursePack(coursePackId, {
      title: packMeta.value.title,
      description: packMeta.value.description,
      cover: packMeta.value.cover,
      video: packMeta.value.video,
      courses: { statements },
    });
    applyToLearning(nextStatement);
    toast.success("句子已更新，本题已重新开始");
    closeStatementEditModal();
  } catch (error: unknown) {
    const message = (error as { message?: string })?.message;
    errorMessage.value = message ? `保存失败：${message}` : "保存失败，请稍后再试";
  } finally {
    isSaving.value = false;
  }
}

/** 用新句子就地更新本地学习数据，避免整页重进；再按新文本重开本题 */
function applyToLearning(next: CreateCoursePackStatement) {
  const learning = courseStore.currentLearning;
  const target = learning?.statements[currentIndex.value];
  if (!learning || !target) return;

  const englishChanged = next.english !== target.english;
  learning.statements[currentIndex.value] = {
    ...target,
    english: next.english,
    chinese: next.chinese,
    soundmark: next.phonetic ?? "",
    startTime: next.startTime ?? null,
    endTime: next.endTime ?? null,
    // 英文变了则逐词时间戳失效（服务端同样按新文本置空），回退 TTS
    words: englishChanged ? null : target.words,
  };

  courseStore.updateMarketedStatements();
  resetQuestionInput();
  showQuestion();
}

function handleClose() {
  if (isSaving.value) return;
  closeStatementEditModal();
}

function parseTiming(raw: unknown): { value?: number; invalid?: boolean } {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return { invalid: true };
  return { value };
}

/** 数字输入框可能回传 number / null，统一成表单里的字符串 */
function toTimingInput(raw: string | number | null | undefined) {
  return raw === null || raw === undefined ? "" : String(raw);
}

function toInputText(value: number | null | undefined) {
  return value === null || value === undefined ? "" : String(value);
}
</script>
