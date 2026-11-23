<template>
  <UModal v-model="contentsVisible">
    <UContainer
      :ui="{
        base: 'w-[90vw] h-[80vh] flex flex-col',
        constrained: 'max-w-[880px] max-h-[880px]',
      }"
    >
      <CommonModalHeader
        title="课程目录"
        @close="hideCourseContents"
      />
      <!-- 每页最多 100 条：句子很多时只按页请求，不在前端一次性渲染全量 -->
      <div class="mb-4 flex items-center justify-between gap-4">
        <span class="text-sm text-gray-500 dark:text-gray-400">共 {{ total }} 句</span>
        <USelect
          v-model="filterOption"
          :options="options"
        >
        </USelect>
      </div>
      <div
        ref="listRef"
        class="min-h-0 flex-1 space-y-3 overflow-y-auto"
        :class="{ 'pointer-events-none opacity-50': isLoading }"
      >
        <div
          v-for="item in items"
          :key="`${item.index}-${item.english}`"
          :data-index="item.index"
          class="flex items-center justify-between rounded-lg bg-purple-100 p-4 transition-colors duration-300 hover:bg-purple-200 dark:bg-purple-700 dark:hover:bg-purple-600"
          @click="jumpTo(item)"
          :class="{ 'cursor-pointer': !item.isMastered, 'cursor-not-allowed': item.isMastered }"
        >
          <div class="group flex w-full flex-grow">
            <div class="mr-4 flex w-6 flex-shrink-0 flex-col items-center justify-center">
              <span class="text-lg font-semibold text-purple-600 dark:text-purple-300">
                {{ item.index + 1 }}
              </span>
              <UIcon
                v-if="item.isMastered"
                name="i-icon-park-outline:correct"
                class="mt-1 h-5 w-5 text-green-700 dark:text-green-500"
              ></UIcon>
            </div>
            <div class="flex-grow overflow-hidden">
              <div
                class="truncate text-lg font-bold text-purple-800 group-hover:text-clip group-hover:whitespace-normal dark:text-white"
              >
                {{ item.english }}
              </div>
              <div
                class="truncate text-lg text-purple-600 group-hover:text-clip group-hover:whitespace-normal dark:text-purple-300"
              >
                {{ item.chinese }}
              </div>
              <div
                class="truncate text-lg text-gray-500 group-hover:text-clip group-hover:whitespace-normal dark:text-gray-400"
              >
                {{ item.soundmark }}
              </div>
            </div>
            <div
              @click=""
              class="flex w-11 flex-shrink-0 cursor-pointer items-center justify-center transition-transform duration-300 hover:scale-110"
            >
              <UTooltip text="播放发音">
                <UIcon
                  name="i-ph-speaker-simple-high"
                  class="ml-1 inline-block h-7 w-7 cursor-pointer"
                  @click="handlePlayEnglishSound($event, item)"
                ></UIcon>
              </UTooltip>
            </div>
          </div>
        </div>

        <div
          v-if="isLoading"
          class="py-6 text-center text-gray-500 dark:text-gray-400"
        >
          加载中…
        </div>
        <div
          v-else-if="items.length === 0"
          class="py-6 text-center text-gray-500 dark:text-gray-400"
        >
          没有符合条件的句子
        </div>
      </div>

      <!-- 分页：每页 100 条，超过则翻页 -->
      <div class="mt-4 flex flex-shrink-0 items-center justify-center gap-4">
        <UButton
          size="sm"
          variant="soft"
          :disabled="page <= 1 || isLoading"
          @click="goToPage(page - 1)"
        >
          上一页
        </UButton>
        <span class="text-sm text-gray-600 dark:text-gray-300">
          第 {{ page }} 页(共 {{ totalPages }} 页)
        </span>
        <UButton
          size="sm"
          variant="soft"
          :disabled="page >= totalPages || isLoading"
          @click="goToPage(page + 1)"
        >
          下一页
        </UButton>
      </div>
    </UContainer>
  </UModal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import type { StatementPageItemApiResponse, StatementsFilter } from "~/api/course-pack";
import { fetchCoursePackStatements } from "~/api/course-pack";
import { playEnglish } from "~/composables/main/englishSound";
import { useGameMode } from "~/composables/main/game";
import { useCourseContents } from "~/composables/main/useCourseContents";
import { useCourseStore } from "~/store/course";

/** 每页最多 100 条，与后端上限一致 */
const PAGE_SIZE = 100;

const { contentsVisible, hideCourseContents } = useCourseContents();

const listRef = ref<HTMLElement | null>(null);
const coursesStore = useCourseStore();
const { showQuestion } = useGameMode();

const items = ref<StatementPageItemApiResponse[]>([]);
const page = ref(1);
const totalPages = ref(1);
const total = ref(0);
const isLoading = ref(false);

const filterOption = ref<StatementsFilter>("all");
const options = [
  { label: "全部", value: "all" },
  { label: "已经掌握", value: "mastered" },
  { label: "未掌握", value: "notMastered" },
];

const coursePackId = computed(() => coursesStore.currentLearning?.coursePackId);

/** 快速翻页/切筛选时只认最后一次请求的结果 */
let requestId = 0;

/**
 * 只取一页：分页与筛选都在服务端做，前端不持有全量句子。
 * scrollToIndex 传入完整列表里的句子下标时，加载完滚到该句。
 */
async function loadPage(targetPage: number, scrollToIndex?: number) {
  const id = coursePackId.value;
  if (!id) return;

  const currentRequest = ++requestId;
  isLoading.value = true;
  try {
    const result = await fetchCoursePackStatements(id, {
      page: targetPage,
      pageSize: PAGE_SIZE,
      filter: filterOption.value,
    });

    if (currentRequest !== requestId) return;

    // 句子变少时请求页可能越界，退回最后一页
    if (result.items.length === 0 && result.total > 0 && result.page > result.totalPages) {
      return await loadPage(result.totalPages, scrollToIndex);
    }

    items.value = result.items;
    page.value = result.page;
    totalPages.value = result.totalPages;
    total.value = result.total;

    await nextTick();
    scrollTo(scrollToIndex);
  } finally {
    if (currentRequest === requestId) {
      isLoading.value = false;
    }
  }
}

function scrollTo(index?: number) {
  const container = listRef.value;
  if (!container) return;

  if (index === undefined) {
    container.scrollTop = 0;
    return;
  }

  const target = container.querySelector<HTMLElement>(`[data-index="${index}"]`);
  if (!target) return;

  const offset =
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop;
  container.scrollTop = Math.max(0, offset - 8);
}

function goToPage(targetPage: number) {
  if (targetPage < 1 || targetPage > totalPages.value || targetPage === page.value) return;
  void loadPage(targetPage);
}

function jumpTo(item: StatementPageItemApiResponse) {
  if (item.isMastered) {
    return;
  }
  showQuestion();
  hideCourseContents();
  // index 是句子在完整列表里的下标（跨页唯一），直接用它跳句
  coursesStore.toSpecificStatement(item.index);
}

function handlePlayEnglishSound(event: Event, statement: { english?: string }) {
  event.stopPropagation();
  playEnglish(statement);
}

// 打开目录：默认定位到当前句所在页；切到筛选视图时从第一页看起
watch(contentsVisible, (visible) => {
  if (!visible) return;

  if (filterOption.value === "all") {
    const currentIndex = coursesStore.statementIndex;
    void loadPage(Math.floor(currentIndex / PAGE_SIZE) + 1, currentIndex);
  } else {
    void loadPage(1);
  }
});

watch(filterOption, () => {
  if (!contentsVisible.value) return;
  void loadPage(1);
});
</script>

<style scoped></style>
