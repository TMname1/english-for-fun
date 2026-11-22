import { spawnSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "ssh2";

/**
 * 后端一键部署：本地构建/推送镜像 → 上传 env 与 compose → 服务器拉取并重启。
 * 见 README.deploy.md。运行前务必已按 README.backend.md 手动成功部署过一次。
 *
 * 用法：pnpm deploy:serve  （即 tsx --env-file=scripts/.env.prod scripts/backend-deploy.ts）
 */

// —— 环境变量校验（来自 scripts/.env.prod，模板见 scripts/.env.prod.example）——
function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback?.trim();
  if (!value) {
    throw new Error(
      `缺少环境变量 ${name}，请在 scripts/.env.prod 中填写（模板：scripts/.env.prod.example）`,
    );
  }
  return value;
}

const ACR_REGISTRY = requireEnv("ACR_REGISTRY", "registry.cn-hangzhou.aliyuncs.com");
const ACR_NAMESPACE = requireEnv("ACR_NAMESPACE");
const ACR_USERNAME = requireEnv("ACR_USERNAME");
const ACR_PASSWORD = requireEnv("ACR_PASSWORD");
const IMAGE_NAME = requireEnv("IMAGE_NAME", "earthworm-api");
const TAG_PREFIX = requireEnv("IMAGE_TAG_PREFIX", "v1");

const SSH_HOST = requireEnv("SSH_HOST");
const SSH_USER = requireEnv("SSH_USER");
const SSH_PASSWORD = requireEnv("SSH_PASSWORD");
const SSH_PORT = Number(requireEnv("SSH_PORT", "22"));
const REMOTE_DIR = requireEnv("REMOTE_DIR", "/opt/earthworm");

// —— 本地待上传的三个文件（apps/api/deploy/ 是 source of truth）——
const DEPLOY_DIR = path.resolve(process.cwd(), "apps/api/deploy");
const COMPOSE_FILE = path.join(DEPLOY_DIR, "docker-compose.yml");
const ENV_FILE = path.join(DEPLOY_DIR, ".env");
const ENV_PROD_FILE = path.join(DEPLOY_DIR, ".env.prod");

const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(`\n\x1b[36m==>\x1b[0m ${msg}`);
}

/** 判断输出中是否包含 Docker 守护进程未启动的特征信息。 */
function isDockerNotRunning(output: string): boolean {
  return /error during connect|cannot connect to the Docker daemon|Is the docker daemon running|dockerDesktopLinuxEngine|The system cannot find the file specified|docker daemon/i.test(
    output,
  );
}

function run(cmd: string, args: string[]): void {
  log([cmd, ...args].join(" "));
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "pipe",
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (cmd === "docker" && isDockerNotRunning(output)) {
      throw new Error(
        `Docker 环境未就绪，请先启动本地 Docker Desktop（或 Docker 服务），确认 Docker 引擎正常运行后重试。\n原始错误：${output}`,
      );
    }
    throw new Error(`命令失败（退出码 ${result.status}）：${cmd} ${args.join(" ")}\n${output}`);
  }
}

/** 取最后一条 git 提交的短哈希，拼成唯一镜像 tag。 */
function gitShortHash(): string {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("无法获取 git 短哈希，请确认在 git 仓库根目录运行。");
  }
  return result.stdout.trim();
}

/**
 * 把 apps/api/deploy/.env 里的 API_IMAGE 改成本次的新 tag（仅用于上传，
 * 不回写本地文件），返回改写后的内容。
 */
function buildRemoteEnv(newImageRef: string): string {
  const original = readFileSync(ENV_FILE, "utf8");
  const lines = original.split(/\r?\n/).map((line) => {
    if (/^\s*API_IMAGE\s*=/.test(line)) return `API_IMAGE=${newImageRef}`;
    return line;
  });
  const content = lines.join("\n");
  if (!content.includes(`API_IMAGE=${newImageRef}`)) {
    throw new Error(
      `${ENV_FILE} 中没有 API_IMAGE 行，无法注入新镜像地址。请参考 .env.example 补上。`,
    );
  }
  return content;
}

function sshConnect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => resolve(conn))
      .on("error", reject)
      .connect({
        host: SSH_HOST,
        port: SSH_PORT,
        username: SSH_USER,
        password: SSH_PASSWORD,
        readyTimeout: 30_000,
      });
  });
}

function sftpPutFile(conn: Client, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const input = createReadStream(localPath);
      const stream = sftp
        .createWriteStream(remotePath, { flags: "w", mode: 0o600 })
        .on("close", () => resolve())
        .on("error", reject);
      input.on("error", reject).pipe(stream);
    });
  });
}

/** 用本地读取的字符串内容写入远端文件（用于改写后的 .env）。 */
function sftpPutContent(conn: Client, content: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp
        .createWriteStream(remotePath, { flags: "w", mode: 0o600 })
        .on("close", () => resolve())
        .on("error", reject);
      stream.end(content);
    });
  });
}

/**
 * 在服务器上执行一条命令。passwordForStdin 会写入命令的 stdin
 * （供 docker login --password-stdin 使用，避免密码出现在命令行里）。
 */
function sshExec(conn: Client, command: string, passwordForStdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stderr = "";
      stream
        .on("data", (data: Buffer) => process.stdout.write(data.toString()))
        .on("stderr", (data: Buffer) => {
          const text = data.toString();
          process.stderr.write(text);
          stderr += text;
        })
        .on("close", (code: number | null) => {
          if (code === 0) return resolve();
          reject(new Error(`远端命令失败（退出码 ${code}）：${command}\n${stderr}`));
        });
      if (passwordForStdin !== undefined) {
        stream.end(`${passwordForStdin}\n`);
      }
    });
  });
}

/**
 * 生成一条在服务器上执行的清理命令：删除与本仓库同前缀、但不是当前 keepImageRef 的所有旧 tag，仅保留本次正在使用的这一个。只作用于服务器本地磁盘
 * 云端 ACR 历史 tag全部保留作为回滚来源。
 * 末尾 `|| true` 让单条 docker rmi 失败（如旧 tag 仍被停止容器占用）不影响整体退出码，从而不会让部署判定为失败。
 */
function buildCleanupCommand(keepImageRef: string): string {
  const prefix = `${ACR_REGISTRY}/${ACR_NAMESPACE}/${IMAGE_NAME}:`;
  // grep -F 固定字符串匹配，避免前缀里的 . 被当成正则元字符误匹配；grep -Fvx 整行精确排除要保留的当前镜像。
  return (
    `docker images --format '{{.Repository}}:{{.Tag}}'` +
    ` | grep -F '${prefix}'` +
    ` | grep -Fvx '${keepImageRef}'` +
    ` | xargs -r -n1 docker rmi || true`
  );
}

async function main(): Promise<void> {
  const shortHash = gitShortHash();
  const tag = `${TAG_PREFIX}-${shortHash}`;
  const remoteImageRef = `${ACR_REGISTRY}/${ACR_NAMESPACE}/${IMAGE_NAME}:${tag}`;
  const localImageRef = `${IMAGE_NAME}:local`;

  log(`本次镜像 tag：${tag}（远端引用：${remoteImageRef}）`);

  // 1. 本地构建 linux/amd64 镜像
  run("docker", [
    "build",
    "--platform",
    "linux/amd64",
    "-f",
    "apps/api/Dockerfile",
    "-t",
    localImageRef,
    ".",
  ]);

  // 2. 打 tag 指向 ACR
  run("docker", ["tag", localImageRef, remoteImageRef]);

  // 3. 本地登录 ACR（密码走 stdin）
  log("docker login (本地)");
  const localLogin = spawnSync(
    "docker",
    ["login", "--username", ACR_USERNAME, "--password-stdin", ACR_REGISTRY],
    { input: ACR_PASSWORD, encoding: "utf8", shell: process.platform === "win32" },
  );
  if (localLogin.status !== 0) {
    const output = [localLogin.stdout, localLogin.stderr].filter(Boolean).join("\n").trim();
    if (isDockerNotRunning(output)) {
      throw new Error(
        `Docker 环境未就绪，请先启动本地 Docker Desktop（或 Docker 服务），确认 Docker 引擎正常运行后重试。\n原始错误：${output}`,
      );
    }
    throw new Error(`本地 docker login 失败：${output}`);
  }

  // 4. 推送镜像
  run("docker", ["push", remoteImageRef]);

  // 5-9. 连接服务器：覆盖 env/compose → 登录 ACR → cd → pull → up
  log(`SSH 连接 ${SSH_USER}@${SSH_HOST}:${SSH_PORT}`);
  const conn = await sshConnect();
  try {
    const remoteEnvContent = buildRemoteEnv(remoteImageRef);

    log("上传 docker-compose.yml / .env.prod / .env（API_IMAGE 已更新为新 tag）");
    await sftpPutFile(conn, COMPOSE_FILE, `${REMOTE_DIR}/docker-compose.yml`);
    await sftpPutFile(conn, ENV_PROD_FILE, `${REMOTE_DIR}/.env.prod`);
    await sftpPutContent(conn, remoteEnvContent, `${REMOTE_DIR}/.env`);

    log("服务器 docker login");
    await sshExec(
      conn,
      `docker login --username='${ACR_USERNAME}' --password-stdin '${ACR_REGISTRY}'`,
      ACR_PASSWORD,
    );

    log(`服务器 docker compose pull && up -d（目录：${REMOTE_DIR}）`);
    await sshExec(conn, `cd '${REMOTE_DIR}' && docker compose pull && docker compose up -d`);

    log("清理服务器本地旧镜像（仅保留当前使用的 tag）");
    await sshExec(conn, buildCleanupCommand(remoteImageRef));
    await sshExec(
      conn,
      `docker images | grep '${ACR_REGISTRY}/${ACR_NAMESPACE}/${IMAGE_NAME}' || true`,
    );
  } finally {
    conn.end();
  }

  log(`\x1b[32m部署完成\x1b[0m：${remoteImageRef}`);
}

main().catch((error: unknown) => {
  console.error(
    `\n\x1b[31m部署失败\x1b[0m：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
