#!/usr/bin/env bash
# ============================================================================
# 线上 forge 上传 524 诊断脚本（只读为主，--oss-probe 才有副作用）
#
# 用法（在服务器上，任意目录）：
#   bash diag-forge-upload.sh                 # 纯只读，出一份报告
#   bash diag-forge-upload.sh --oss-probe     # 额外做 8MB 直传 OSS 计时（会创建并清理测试对象）
#
# 可选环境变量：
#   COMPOSE_DIR=/opt/earthworm   生产部署目录（含 docker-compose.yml / .env / .env.prod）
#   CF_HOST=https://api.bananablog.cc
#   REPORT=/tmp/xxx.log          报告路径
#
# 说明：api 容器是 node:22-bookworm-slim，没有 curl，容器内探测一律用 node -e。
#
# 隐私：脚本不读取 .env、不打印 AK/SK；cloudflared 段刻意不用 systemctl status
# （其 CGroup 行会把 ExecStart 里的 --token 明文打出来），日志也过滤掉 token 行。
# 结尾会自动生成 <报告>.redacted.log（遮蔽 token / 预签名签名串 / AK ID），回传那份。
# ============================================================================
set -uo pipefail
# 报告只有属主可读：/tmp 下默认 644 会让同机其他用户读到
umask 077

COMPOSE_DIR="${COMPOSE_DIR:-/opt/earthworm}"
CF_HOST="${CF_HOST:-https://api.bananablog.cc}"
LOCAL_API="http://127.0.0.1:3001"
OSS_PROBE=0

for arg in "$@"; do
  case "$arg" in
    --oss-probe) OSS_PROBE=1 ;;
    -h|--help) sed -n '2,/^set -uo/{/^set -uo/d;p}' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（可用：--oss-probe）"; exit 2 ;;
  esac
done

REPORT="${REPORT:-/tmp/diag-forge-upload-$(date +%Y%m%d-%H%M%S).log}"
: >"$REPORT"
# 所有输出同时进报告
exec > >(tee -a "$REPORT") 2>&1

section() { printf '\n===== %s =====\n' "$*"; }
note() { printf '  · %s\n' "$*"; }
cmd() {
  printf '$ %s\n' "$*"
  eval "$*"
}

section "0. 基本信息"
note "时间：$(date -Is)"
note "主机：$(hostname) $(uname -r)"
note "部署目录：$COMPOSE_DIR"
note "报告：$REPORT"
if [ ! -f "$COMPOSE_DIR/docker-compose.yml" ]; then
  echo "错误：$COMPOSE_DIR 下没有 docker-compose.yml，请用 COMPOSE_DIR=... 指定部署目录"
  exit 1
fi
cd "$COMPOSE_DIR" || exit 1

DC="docker compose"

section "1. 容器状态（api 是否在跑 / 是否反复重启）"
cmd "$DC ps"
api_cid="$($DC ps -q api 2>/dev/null | head -1)"
if [ -n "$api_cid" ]; then
  cmd "docker inspect $api_cid --format 'OOMKilled={{.State.OOMKilled}} Restarts={{.RestartCount}} Status={{.State.Status}} StartedAt={{.State.StartedAt}}'"
  note "OOMKilled=true 或 Restarts>0 且 StartedAt 接近故障时间 → 容器资源问题（H4）"
else
  note "api 容器不存在，检查 docker compose ps / .env 的 API_IMAGE"
fi

section "2. api 日志（近 6 小时）"
cmd "$DC logs --since 6h --tail 300 api"
note "重点找：TimeoutError / ECONNRESET / S3ServiceException / SignatureDoesNotMatch / NoSuchBucket / 重启横幅"
cmd "$DC logs --since 24h api 2>&1 | grep -Ei 'timeout|econnreset|s3|oss|aborted|killed' | tail -50 || true"
note "若上传时日志完全静默 → 卡在 multer 收包或 OSS 上传（createJob 目前没有任何日志）"

section "3. cloudflared（隧道侧；输出已过滤 token）"
# 不用 systemctl status：它的 CGroup 段会完整回显 ExecStart，隧道若用
# `cloudflared tunnel run --token eyJ...` 启动，token 会明文落到报告里。
cmd "systemctl show cloudflared -p ActiveState,SubState,NRestarts,MemoryCurrent --no-pager 2>&1 || true"
note "ActiveState=active 且 NRestarts 稳定 → 进程健康；NRestarts 持续增长 → 隧道在反复重连"
cmd "journalctl -u cloudflared --since '-3h' --no-pager 2>&1 | grep -Ei 'err|warn|dial|edge|protocol|quic|retry|timeout|abrupt' | grep -vi 'token' | tail -120 || true"
cmd "journalctl -u cloudflared --since '-3h' --no-pager 2>&1 | grep -c 'Registered tunnel connection' || true"
note "↑ 3 小时内重连次数；几十次以上 = 隧道不稳（对应 H1）"
cmd "journalctl -u cloudflared --since '-3h' --no-pager 2>&1 | grep -Eo 'location=[a-z0-9]+' | sort | uniq -c | sort -rn | head -5 || true"
note "边缘节点长期是 lax*（洛杉矶）→ 大陆→美西→回源的跨国链路，正是 ~47KB/s 的来源之一"
note "出现 Unable to reach the origin service / dial tcp → 隧道到源站有问题（H5，通常表现为 502 而非 524）"

section "4. 资源：内存 / 磁盘 / OOM"
cmd "free -m"
cmd "df -h / | tail -2"
if [ -n "$api_cid" ]; then
  cmd "$DC exec -T api df -h /tmp 2>&1 | tail -2 || true"
  cmd "$DC exec -T api ls -l /tmp/earthworm-uploads 2>&1 | tail -8 || true"
  note "若这里有完整 8,388,608 字节的 *.mp4 残留 → multer 已收完，卡在 OSS 段（H1/H2）"
fi
cmd "dmesg -T 2>/dev/null | grep -i 'oom\\|killed process' | tail -10 || true"

section "5. 出网下行测速（定性判断带宽是否是瓶颈）"
cmd "curl -s -o /dev/null -w 'down=%{speed_download} B/s  time=%{time_total}s  http=%{http_code}\\n' --max-time 30 https://mirrors.aliyun.com/ubuntu-releases/24.04/SHA256SUMS || true"
note "几百 KB/s（≈1–5 Mbps）且 EIP 为固定小带宽 → 8MB 传两遍极易破 100s（H1）"

section "6. 走 Cloudflare 域名的分段计时（只读，401 即正常）"
cmd "curl -s -o /dev/null -w 'dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} http=%{http_code}\\n' --max-time 20 $CF_HOST/auth/me || true"
note "ttfb 应 <1s。这里就 >10s → ECS→CF 出口本身很差（与 H1 同源）"

section "7. 本机回源直连（绕开 CF，401 即正常）"
cmd "curl -s -o /dev/null -w 'ttfb=%{time_starttransfer} total=%{time_total} http=%{http_code}\\n' --max-time 20 $LOCAL_API/auth/me || true"
note "这一步 fast 说明 api 进程健康，问题在上传路径或外网链路"

if [ "$OSS_PROBE" = "1" ]; then
  section "8. OSS 直传探测（有副作用：会写入并在末尾删除 probe/ 下两个对象）"
  note "8MB 单段直传计时；公网端点 vs 同地域内网端点，A/B 对比"
  note "注意：下面会打印桶名（S3_BUCKET）与端点，属内部信息，回传用脱敏副本即可"
  $DC exec -T api node -e '
const fs = require("node:fs");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

const SIZE = 8 * 1024 * 1024;
const local = "/tmp/diag-probe-8mb.bin";
fs.writeFileSync(local, Buffer.alloc(SIZE, 1));

const base = {
  region: process.env.S3_REGION,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
};
const publicEndpoint = process.env.S3_ENDPOINT;
const internalEndpoint = (publicEndpoint || "").replace("oss-cn-hangzhou.aliyuncs.com", "oss-cn-hangzhou-internal.aliyuncs.com");

console.log("S3_ENDPOINT =", publicEndpoint);
console.log("S3_REGION   =", process.env.S3_REGION);
console.log("S3_BUCKET   =", process.env.S3_BUCKET);
console.log("PATH_STYLE  =", base.forcePathStyle);

async function probe(label, endpoint) {
  if (!endpoint) return console.log(label, "skipped (endpoint empty)");
  const client = new S3Client({ ...base, endpoint });
  const key = `probe/diag-${Date.now()}-${label}.bin`;
  const t = Date.now();
  try {
    await new Upload({
      client,
      params: { Bucket: process.env.S3_BUCKET, Key: key, Body: fs.createReadStream(local), ContentType: "application/octet-stream" },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    }).done();
    console.log(`${label} OK  ${Date.now() - t} ms  ${endpoint}`);
  } catch (error) {
    console.log(`${label} ERR ${Date.now() - t} ms  ${error.name}: ${error.message}`);
  }
  try { await client.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key })); } catch {}
}

(async () => {
  await probe("public  ", publicEndpoint);
  await probe("internal", internalEndpoint);
  fs.rmSync(local, { force: true });
})();
'
  note "判读：public 数十秒而 internal <3s → 公网绕行+出口带宽（H1），改用内网端点即可"
  note "      public 秒级 SignatureDoesNotMatch/NoSuchBucket/403 → 配置错（H7）"
  note "      两者都挂住无返回 → SDK 无超时导致连接卡死（H2c）"
else
  section "8. OSS 直传探测（已跳过）"
  note "需要时跑：bash $0 --oss-probe（会在 probe/ 下写入并删除两个 8MB 对象）"
fi

section "9. 报告已落盘"
note "$REPORT"
note "另需人工提供：阿里云控制台 EIP 计费方式与带宽峰值；浏览器 DevTools 该请求的 Timing 截图。"

section "10. 脱敏副本"
# 等 tee 把管道里剩余内容刷完，否则副本可能缺最后几行
sleep 0.3
REDACTED="${REPORT%.log}.redacted.log"
sed -E \
  -e 's/(--token[= ])[A-Za-z0-9._~+/-]+=*/\1***REDACTED***/g' \
  -e 's/(X-Amz-Credential=)[^&" ]+/\1***/g' \
  -e 's/(X-Amz-Signature=)[^&" ]+/\1***/g' \
  -e 's/(OSSAccessKeyId=)[^&" ]+/\1***/g' \
  -e 's/(Signature=)[A-Za-z0-9%._~+/-=]+/\1***/g' \
  "$REPORT" >"$REDACTED" 2>/dev/null || true
if [ -s "$REDACTED" ]; then
  chmod 600 "$REDACTED" 2>/dev/null || true
  note "已生成脱敏副本，回传这份：$REDACTED"
  note "自查：下面应无输出（有输出说明还有未遮蔽的凭据/签名）"
  grep -nE -- '--token[= ]|X-Amz-Signature=|X-Amz-Credential=|OSSAccessKeyId=|Signature=' "$REDACTED" \
    | grep -v '\*\*\*' | head -5 || true
else
  note "脱敏副本生成失败，请手动检查 $REPORT 后再回传"
fi
