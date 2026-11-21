import { Window } from "happy-dom";

// Node>=22 自带实验性 localStorage/sessionStorage getter，vitest 的 populateGlobal
// 会跳过 globalThis 上已存在的键，导致 DOM 环境的实现装不上；这里显式补上。
const win = new Window({ url: "http://localhost:3000" });

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: win.localStorage,
});
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  writable: true,
  value: win.sessionStorage,
});
