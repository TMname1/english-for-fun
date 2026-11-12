import { defineStore } from "pinia";
import { computed, ref, watchEffect } from "vue";

import type { CoursePackLearning, Statement } from "~/types";
import { fetchCompleteCoursePack, fetchCoursePackLearning } from "~/api/course-pack";
import { useMasteredElementsStore } from "~/store/masteredElements";
import { useStatement } from "./statement";

/**
 * 学习进度 store。"分课程"功能已删除：学习单元就是课程包内的唯一课程，
 * 数据源为 CoursePackLearning（原 Course）。
 */
export const useCourseStore = defineStore("course", () => {
  const currentLearning = ref<CoursePackLearning>();
  const currentStatement = ref<Statement>();
  const { statementIndex, setupAutoSaveProgress } = useStatement();
  const masteredElementsStore = useMasteredElementsStore();

  watchEffect(() => {
    currentStatement.value = currentLearning.value?.statements[statementIndex.value];
  });

  const words = computed(() => {
    return currentStatement.value?.english.split(" ") || [];
  });

  const visibleStatementsCount = computed(
    () => currentLearning.value?.statements.filter((s) => !s.isMastered).length || 0,
  );

  const visibleStatementIndex = computed(() => {
    let masteredCount = 0;
    currentLearning.value?.statements.forEach((statement, index) => {
      if (index < statementIndex.value) {
        if (statement.isMastered) {
          masteredCount++;
        }
      }
    });

    if (statementIndex.value - masteredCount >= visibleStatementsCount.value) {
      return statementIndex.value - masteredCount - 1;
    }

    return statementIndex.value - masteredCount;
  });

  const totalQuestionsCount = computed(() => {
    return currentLearning.value?.statements.length || 0;
  });

  function toSpecificStatement(index: number) {
    statementIndex.value = index;
  }

  function findNextUnmasteredIndex(currentIndex: number, direction: 1 | -1) {
    let index = currentIndex;
    while (index >= 0 && index < totalQuestionsCount.value) {
      index += direction;
      if (
        index >= 0 &&
        index < totalQuestionsCount.value &&
        !currentLearning.value!.statements[index].isMastered
      ) {
        return index;
      }
    }
    return -1; // 没有找到未掌握的元素
  }

  function toPreviousStatement() {
    const prevIndex = findNextUnmasteredIndex(statementIndex.value, -1);
    if (prevIndex !== -1) {
      statementIndex.value = prevIndex;
    }
  }

  function toNextStatement() {
    const nextIndex = findNextUnmasteredIndex(statementIndex.value, 1);
    if (nextIndex !== -1) {
      statementIndex.value = nextIndex;
    }
  }

  function resetStatementIndex() {
    const firstIndex = findFirstUnmasteredIndex();
    if (firstIndex !== -1) {
      statementIndex.value = firstIndex;
    }
  }

  function isAllDone() {
    return visibleStatementIndex.value >= visibleStatementsCount.value - 1;
  }

  function isLastStatement() {
    return visibleStatementIndex.value + 1 === visibleStatementsCount.value;
  }

  function isAllMastered() {
    return visibleStatementsCount.value === 0;
  }

  function updateMarketedStatements() {
    if (currentLearning.value) {
      currentLearning.value.statements = markMasteredElements(currentLearning.value.statements);
    }
  }

  function findFirstUnmasteredIndex() {
    if (!currentLearning.value) return 0;
    return currentLearning.value.statements.findIndex((statement) => !statement.isMastered);
  }

  function doAgain() {
    resetStatementIndex();
  }

  async function completeCoursePack() {
    const coursePackId = currentLearning.value?.coursePackId!;
    await fetchCompleteCoursePack(coursePackId);
  }

  async function setup(coursePackId: string) {
    let learning = await fetchCoursePackLearning(coursePackId);

    learning.statements = markMasteredElements(learning.statements);

    currentLearning.value = learning;
    setupAutoSaveProgress(currentLearning);
    if (statementIndex.value === 0) {
      resetStatementIndex();
    }
  }

  function markMasteredElements(statements: Statement[]) {
    return statements.map((statement) => {
      const isMastered = masteredElementsStore.checkMastered(statement.english);

      return {
        ...statement,
        isMastered,
      };
    });
  }

  return {
    statementIndex,
    currentLearning,
    currentStatement,
    words,
    totalQuestionsCount,
    visibleStatementIndex,
    visibleStatementsCount,
    setup,
    doAgain,
    completeCoursePack,
    toSpecificStatement,
    toPreviousStatement,
    toNextStatement,
    resetStatementIndex,
    updateMarketedStatements,
    isLastStatement,
    isAllMastered,
    isAllDone,
  };
});
