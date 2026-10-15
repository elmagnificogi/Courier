import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { IdeTarget, config, ideDebugUrl, ideDisplayName } from "../config";
import { logger } from "../logger";

const LAUNCHABLE: ReadonlySet<IdeTarget> = new Set(["cursor", "codex"]);

export function resolveLaunchIde(arg: string, current: IdeTarget): { ide: IdeTarget } | { error: string } {
  const trimmed = arg.trim().toLowerCase();
  if (!trimmed) {
    if (LAUNCHABLE.has(current)) {
      return { ide: current };
    }
    return { error: "当前目标不能直接启动。请用 /launch cursor 或 /launch codex。" };
  }
  if (trimmed === "cursor" || trimmed === "codex") {
    return { ide: trimmed };
  }
  return { error: "用法：/launch、/launch cursor 或 /launch codex。" };
}

export async function launchIde(ide: IdeTarget): Promise<string> {
  const name = ideDisplayName(ide);
  if (!LAUNCHABLE.has(ide)) {
    return "目前只能启动 Cursor 或 Codex。用法：/launch cursor 或 /launch codex。";
  }
  if (process.platform !== "win32") {
    return "启动 IDE 目前只支持 Windows。";
  }

  const debugUrl = ideDebugUrl(ide).replace(/\/$/, "");
  const port = debugPort(debugUrl, ide);
  if (await debugPortOpen(debugUrl)) {
    return `${name} 已在运行，调试端口已打开。`;
  }

  const state = await inspectMainProcesses(processNames(ide), port);
  if (state === "plain") {
    return `${name} 已在运行，但没有打开远程调试端口。请先完全退出 ${name}，再发送 /launch。`;
  }
  if (state === "debug") {
    const ready = await waitForDebug(debugUrl, 15000);
    return ready
      ? `${name} 已在运行，调试端口已打开。`
      : `${name} 已带调试参数启动，但端口还没打开。过几秒再发指令。`;
  }

  const started = await startIde(ide, port);
  if (!started.ok) {
    return started.message;
  }
  const ready = await waitForDebug(debugUrl, 20000);
  if (ready) {
    return `已启动 ${name}，调试端口已打开。可以直接发指令。`;
  }
  return `已尝试启动 ${name}，但调试端口还没打开。如果窗口没出现，请确认本机已安装 ${name}；如果它本来就开着，请先完全退出再发 /launch。`;
}

function processNames(ide: IdeTarget): string[] {
  return ide === "codex" ? ["Codex.exe", "ChatGPT.exe"] : ["Cursor.exe"];
}

function debugPort(debugUrl: string, ide: IdeTarget): string {
  try {
    const port = new URL(debugUrl).port;
    if (port) {
      return port;
    }
  } catch (error) {
    logger.warn({ error, debugUrl }, "Invalid IDE debug URL");
  }
  return ide === "codex" ? "9225" : "9222";
}

async function debugPortOpen(debugUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${debugUrl}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDebug(debugUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await debugPortOpen(debugUrl)) {
      return true;
    }
    await delay(500);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function inspectMainProcesses(names: string[], port: string): Promise<"absent" | "debug" | "plain" | "unknown"> {
  const nameList = names.map((name) => `'${name.replace(/'/g, "''")}'`).join(",");
  const script = [
    `$names = @(${nameList})`,
    "$procs = @()",
    "foreach ($name in $names) {",
    "  $procs += @(Get-CimInstance Win32_Process -Filter \"Name = '$name'\" | Where-Object { $_.CommandLine -and $_.CommandLine -notlike '*--type=*' })",
    "}",
    "if ($procs.Count -eq 0) { 'absent' }",
    `elseif (@($procs | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${port}*' }).Count -gt 0) { 'debug' }`,
    "else { 'plain' }"
  ].join("\n");
  const result = await runPowerShell(script, 20000);
  const token = result.stdout.trim().split(/\s+/).pop() ?? "";
  if (token === "absent" || token === "debug" || token === "plain") {
    return token;
  }
  logger.warn({ code: result.code, stderr: result.stderr.slice(0, 500) }, "IDE process inspection failed");
  return "unknown";
}

async function startIde(ide: IdeTarget, port: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const name = ideDisplayName(ide);
  const args = [`--remote-debugging-port=${port}`, "--remote-allow-origins=*"];
  const exe = findExe(ide);
  if (exe) {
    try {
      await spawnDetached(exe, args);
      return { ok: true };
    } catch (error) {
      logger.warn({ error, exe }, "Failed to spawn IDE");
      return { ok: false, message: `${name} 启动失败。` };
    }
  }
  if (ide === "codex") {
    return startCodexStoreApp();
  }
  return {
    ok: false,
    message: "没找到 Cursor.exe。把 CURSOR_APP_EXE 设成 Cursor.exe 的完整路径，重启 Courier 后再发 /launch。"
  };
}

function findExe(ide: IdeTarget): string | null {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const candidates =
    ide === "cursor"
      ? [
          configuredCursorExe(),
          "D:\\cursor\\Cursor.exe",
          path.join(localAppData, "Programs", "cursor", "Cursor.exe"),
          path.join(localAppData, "Programs", "Cursor", "Cursor.exe")
        ]
      : [
          path.join(localAppData, "Programs", "Codex", "Codex.exe"),
          path.join(localAppData, "Programs", "ChatGPT", "ChatGPT.exe")
        ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function configuredCursorExe(): string {
  const configured = config.cursorAppExe.trim();
  if (!configured || configured.toLowerCase() === "cursor") {
    return "";
  }
  return configured;
}

async function startCodexStoreApp(): Promise<{ ok: true } | { ok: false; message: string }> {
  const scriptPath = path.resolve(__dirname, "..", "..", "scripts", "windows", "launch-codex-debug.ps1");
  if (!existsSync(scriptPath)) {
    return { ok: false, message: "没找到 Codex 启动脚本。" };
  }
  const quoted = scriptPath.replace(/'/g, "''");
  const result = await runPowerShell(`& '${quoted}' -Quiet`, 30000);
  if (result.code === 0) {
    return { ok: true };
  }
  const detail = `${result.stdout}\n${result.stderr}`;
  logger.warn({ code: result.code, detail: detail.slice(0, 500) }, "Codex store launch failed");
  if (/not installed/i.test(detail)) {
    return { ok: false, message: "没找到 Codex。请先安装 Codex 桌面版，再发 /launch codex。" };
  }
  return { ok: false, message: "Codex 启动失败。请先完全退出已打开的 Codex，再发 /launch codex。" };
}

function spawnDetached(exe: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      detached: true,
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function runPowerShell(
  script: string,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
