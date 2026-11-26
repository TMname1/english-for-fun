# @earthworm/client（前端）

Earthworm 的 Web 客户端：**Nuxt 3（纯 SPA，`ssr: false`）+ Vue 3 + Nuxt UI / Tailwind / daisyUI + Pinia**。
通过键盘打字输入句子的方式学习英语（中译英 / 听写两种玩法），支持视频课程按时间戳播放原声。

## 快速开始

```bash
# 仓库根目录
pnpm dev:client     # 等价于 pnpm -F client dev
```

配置：复制 `apps/client/.env.example` 为 `apps/client/.env`。

| 变量          | 用途                                     |
| ------------- | ---------------------------------------- |
| `API_BASE`    | 后端地址，默认 `http://localhost:3001`   |
| `ALLOW_FORGE` | 是否开放「导入视频」入口（生产环境关闭） |
| `CLARITY`     | Microsoft Clarity 统计 ID（可选）        |

## 页面与功能

| 页面                            | 功能                                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/index.vue`               | 首页：最近课程包 + 学习日历热力图（`components/Home`）                                                                                                                                       |
| `pages/course-pack/index.vue`   | 课程包卡片列表                                                                                                                                                                               |
| `pages/course-pack/[id].vue`    | 课程包详情 +「开始学习」                                                                                                                                                                     |
| `pages/course-pack/manage.vue`  | 管理课程：新建 / 编辑课程包，句子列表编辑、JSON 批量导入                                                                                                                                     |
| `pages/game/[coursePackId].vue` | 学习游戏：自绘逐字符输入（`components/main/QuestionInput`）+ 打字音效；每句分 Question / Answer 两阶段；模式见 `components/mode/chineseToEnglish`（中译英，默认）与 `mode/dictation`（听写） |
| `pages/mastered-elements.vue`   | 已掌握句子列表：搜索 + 删除                                                                                                                                                                  |
| `pages/video-clip.vue`          | 「导入视频」forge 流水线 GUI（见下）                                                                                                                                                         |

### 导入视频（forge GUI）

步骤：**upload → edit → working →（有失败句时 fix）→ 自动 import**（失败进 failed）：

1. **upload**：本地上传视频，或从 B 站下载（扫码登录 → 选分 P → 后台下载）。
2. **edit**：时间轴打切点（空格播放/暂停，`C` 在播放头加切点）、勾选片段；≤5 分钟可不打切点整段转写，单片段上限 300s。
3. **working**：`useForgeJob` 每 2s 轮询后端 job，展示 ASR / LLM 阶段与耗时，可取消。
4. **fix**：后端进入 `needs_fix` 时用 `components/ForgeImport/ForgeStructureFix` 逐句选「删除 / 重试」，
   提交 `POST /forge/jobs/:id/resolve`，后端按 checkpoint 续跑（不重跑已成功句）。
   旧的「转写后人工校对」步骤（`ForgeTranscriptReview`）已停用，组件文件保留未删。
5. **import**：`buildCoursePackPayload` 把产物转成入库 payload → `createCoursePack` → 跳转游戏页。

相关 composables：`composables/forge`（job 轮询、payload 组装）、`composables/videoClip`（`clipMath` 切点/区间纯函数与校验、`useClipEditor` 勾选状态、`useClipPlayer` 播放头/区间预览）。

## 播放逻辑

`composables/main/englishSound/`：课程包带视频且句子有 `startTime`/`endTime` 时，seek 视频播放原声区间（rAF 监控终点）；否则回退服务端 TTS（`GET /tts`）。单词级发音同理（`audio.ts` 的 `findWordVideoTiming`）。支持倍速与重复播放。

## 状态与 API 对接

- **store（Pinia）**：`course` 当前学习进度/句子；`coursePack` 课程包列表与详情；`game` 游戏状态机 + 学习计时；`masteredElements` 已掌握句子；`statement` 句索引 + 防抖自动保存进度。
- **API**：`api/http.ts` 用 `ofetch.create` 封装，baseURL 取 `runtimeConfig.public.apiBase`（`plugins/http.ts` 初始化），retry 3 次、统一错误处理；各资源 API 在 `api/*.ts`。

## 测试

```bash
cd apps/client
pnpm test:unit:run    # Vitest（happy-dom）
pnpm test:unit:watch  # 监听模式
pnpm test:e2e:run     # Cypress
pnpm type-check       # nuxi typecheck
```

## 构建

```bash
pnpm build:client   # 根目录：nuxt generate 产静态站点
```
