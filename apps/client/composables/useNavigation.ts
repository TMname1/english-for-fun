import { navigateTo } from "#app";

export function useNavigation() {
  function gotoCourseList(coursePackId: string) {
    navigateTo(`/course-pack/${coursePackId}`);
  }

  function gotoGame(coursePackId: string) {
    navigateTo(`/game/${coursePackId}`);
  }

  return {
    gotoCourseList,
    gotoGame,
  };
}
