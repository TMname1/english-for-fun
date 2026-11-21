import { defineNuxtRouteMiddleware, navigateTo, useState } from "#imports";

import type { AuthUser } from "~/api/auth";
import { fetchMe } from "~/api/auth";

export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === "/login") return;

  const authUser = useState<AuthUser | null>("authUser", () => null);
  if (authUser.value) return;

  try {
    authUser.value = await fetchMe();
  } catch {
    return navigateTo("/login");
  }
});
