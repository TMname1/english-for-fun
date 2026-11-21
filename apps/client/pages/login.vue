<template>
  <div
    class="flex min-h-screen items-center justify-center bg-white px-4 text-slate-600 transition-colors dark:bg-theme-dark dark:text-slate-300"
  >
    <UCard class="w-full max-w-sm">
      <div class="mb-6 flex flex-col items-center gap-3">
        <img
          width="64"
          height="64"
          class="rounded-md"
          src="/avatar.png"
          alt="EnglishForFun logo"
        />
        <h1 class="text-2xl font-extrabold dark:text-white">EnglishForFun</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400">登录后开始学习</p>
      </div>

      <UForm
        :state="state"
        class="space-y-4"
        @submit="onSubmit"
      >
        <UFormGroup
          label="用户名"
          name="username"
        >
          <UInput
            v-model="state.username"
            autocomplete="username"
            :disabled="loading"
          />
        </UFormGroup>

        <UFormGroup
          label="密码"
          name="password"
        >
          <UInput
            v-model="state.password"
            type="password"
            autocomplete="current-password"
            :disabled="loading"
          />
        </UFormGroup>

        <p
          v-if="errorMessage"
          class="text-sm text-red-500"
        >
          {{ errorMessage }}
        </p>

        <UButton
          type="submit"
          block
          :loading="loading"
        >
          登录
        </UButton>
      </UForm>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { definePageMeta, navigateTo, useState } from "#imports";
import { reactive, ref } from "vue";

import type { AuthUser } from "~/api/auth";
import { login } from "~/api/auth";

definePageMeta({ layout: false });

const state = reactive({ username: "", password: "" });
const loading = ref(false);
const errorMessage = ref("");
const authUser = useState<AuthUser | null>("authUser", () => null);

async function onSubmit() {
  if (!state.username || !state.password) {
    errorMessage.value = "请输入用户名和密码";
    return;
  }

  loading.value = true;
  errorMessage.value = "";
  try {
    authUser.value = await login(state.username, state.password);
    navigateTo("/");
  } catch (error) {
    errorMessage.value = (error as { message?: string })?.message ?? "登录失败";
  } finally {
    loading.value = false;
  }
}
</script>
