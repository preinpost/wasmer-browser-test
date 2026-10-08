#!/usr/bin/env node
// feat/browser-ingest-wasmer 브랜치 검증용 스모크 테스트 (terminal 전용)
//
// 사용법:
//   node test.mjs            # 전체 실행 (yt-dlp 설치 포함, 몇 분 소요)
//   node test.mjs --no-net   # pip·yt-dlp 단계를 건너뛰고 로컬 실행만 확인
//
// 브랜치에서 고정한 것과 동일한 버전을 사용합니다.
//   @wasmer/sdk@0.19.1, python@=3.13.20, quickjs@=0.15.1, ffmpeg@=1.0.5,
//   yt-dlp==2026.8.19

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SDK_VERSION = "0.19.1";
const PACKAGES = {
  python: "python/python@=3.13.20",
  quickjs: "wasmer/quickjs@=0.15.1",
  ffmpeg: "wasmer/ffmpeg@=1.0.5",
};
const YTDLP_VERSION = "2026.8.19";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const skipNet = process.argv.includes("--no-net");

// ---- terminal 출력 헬퍼 ----------------------------------------------------

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const pass = (s) => `\x1b[32mPASS\x1b[0m ${s}`;
const fail = (s) => `\x1b[31mFAIL\x1b[0m ${s}`;
const header = (s) => console.log(`\n${bold(`== ${s} ==`)}`);

function excerpt(text, maxLines = 8) {
  const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n").filter((l) => l.trim());
  if (lines.length === 0) return dim("(출력 없음)");
  const shown = lines.slice(0, maxLines);
  const more = lines.length > maxLines ? dim(`  … 외 ${lines.length - maxLines}줄`) : "";
  return shown.map((l) => `  ${l}`).join("\n") + (more ? `\n${more}` : "");
}

function summarize(out) {
  return { code: `${out.exitCode} (${out.reason})`, stdout: out.stdout?.text() ?? "", stderr: out.stderr?.text() ?? "" };
}

// ---- 의존성 부트스트랩 ------------------------------------------------------

const require = createRequire(import.meta.url);
try {
  require.resolve("@wasmer/sdk/node");
} catch {
  console.log(dim(`@wasmer/sdk가 없어서 설치합니다: @wasmer/sdk@${SDK_VERSION}`));
  const r = spawnSync("npm", ["install", `@wasmer/sdk@${SDK_VERSION}`], { cwd: scriptDir, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(fail("npm install 실패"));
    process.exit(1);
  }
}

const { Wasmer } = await import("@wasmer/sdk/node");

// ---- 테스트 본체 -----------------------------------------------------------

const wasmer = new Wasmer({ parallelism: 2 });
await wasmer.ready();
const results = [];

async function step(title, fn) {
  header(title);
  const t0 = Date.now();
  try {
    const note = await fn();
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    results.push({ title, ok: true });
    console.log(pass(`${title} ${dim(`(${sec}s)`)}${note ? dim(` — ${note}`) : ""}`));
  } catch (error) {
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    results.push({ title, ok: false });
    console.error(fail(`${title} ${dim(`(${sec}s)`)}`));
    console.error(dim(String(error?.stack || error)));
  }
}

async function runIn(sandbox, name, args, options = {}) {
  const out = await sandbox.command(name, args, { cwd: "/workspace", ...options.cmd }).run({
    timeoutMs: options.timeoutMs ?? 60_000,
    outputBytes: 256 * 1024,
    check: false,
    ...options.run,
  });
  const { code, stdout, stderr } = summarize(out);
  console.log(dim(`  $ ${name} ${args.join(" ")}`));
  console.log(dim(`  exit: ${code}`));
  if (stdout.trim()) console.log(excerpt(stdout));
  if (stderr.trim()) console.log(dim("  [stderr]"));
  if (stderr.trim()) console.log(excerpt(stderr, 4));
  if (!out.ok) throw new Error(`${name} 종료 코드 ${out.exitCode}`);
  return out;
}

// 0. 각 패키지가 노출하는 명령(바이너리) 목록 확인
const commandNames = {};
for (const [label, source] of Object.entries(PACKAGES)) {
  await step(`패키지 로드: ${source}`, async () => {
    const pkg = await wasmer.packages.load(source);
    commandNames[label] = { commands: [...pkg.commands], entrypoint: pkg.entrypoint };
    return `commands: ${pkg.commands.join(", ")} / entrypoint: ${pkg.entrypoint}`;
  });
}

// 1. QuickJS 실행
if (commandNames.quickjs) {
  await step("QuickJS 실행", async () => {
    const sandbox = await wasmer.sandboxes.create({
      packages: [PACKAGES.quickjs],
      files: { "hello.js": `print("hello from quickjs", 1 + 2);\n` },
    });
    try {
      await runIn(sandbox, "qjs", ["/workspace/hello.js"]);
    } finally {
      await sandbox.close();
    }
  });
}

// 2. Python 실행
if (commandNames.python) {
  await step("Python 실행 (--version)", async () => {
    const sandbox = await wasmer.sandboxes.create({ packages: [PACKAGES.python] });
    try {
      await runIn(sandbox, "python", ["--version"]);
    } finally {
      await sandbox.close();
    }
  });
}

// 3. FFmpeg 실행
if (commandNames.ffmpeg) {
  await step("FFmpeg 실행 (-version)", async () => {
    const sandbox = await wasmer.sandboxes.create({ packages: [PACKAGES.ffmpeg] });
    try {
      await runIn(sandbox, "ffmpeg", ["-version"]);
    } finally {
      await sandbox.close();
    }
  });
}

// 4. yt-dlp 설치 + 실행 (네트워크 필요: Node에서는 node:net 브리지 사용)
if (!skipNet && commandNames.python) {
  await step(`yt-dlp 설치 (pip install yt-dlp==${YTDLP_VERSION})`, async () => {
    const sandbox = await wasmer.sandboxes.create({
      packages: [PACKAGES.python],
      network: { mode: "host" },
    });
    try {
      await runIn(
        sandbox,
        "python",
        ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-cache-dir",
          "--target", "/workspace/.python-packages", `yt-dlp==${YTDLP_VERSION}`],
        { timeoutMs: 180_000 },
      );
      await runIn(sandbox, "python", ["-m", "yt_dlp", "--version"], {
        cmd: { env: { PYTHONPATH: "/workspace/.python-packages" } },
      });
      await runIn(sandbox, "python", ["-m", "yt_dlp", "--help"], {
        cmd: { env: { PYTHONPATH: "/workspace/.python-packages" } },
      });
    } finally {
      await sandbox.close();
    }
  });
}

// ---- 요약 ------------------------------------------------------------------

header("요약");
for (const r of results) console.log(`${r.ok ? pass("PASS") : fail("FAIL")}  ${r.title}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 통과${failed ? `, ${failed}개 실패` : ""}`);

await wasmer.close();
process.exit(failed ? 1 : 0);
