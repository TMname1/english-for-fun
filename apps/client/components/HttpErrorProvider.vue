<template>
  <slot></slot>
</template>

<script setup lang="ts">
import { toast } from "vue-sonner";

import { injectHttpStatusErrorHandler } from "~/api/http.js";

useHttpStatusError();

function useHttpStatusError() {
  injectHttpStatusErrorHandler((errMessage) => {
    toast.error(errMessage);
  });
}
</script>
