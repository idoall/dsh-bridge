// 无托管器场景下的 DSH 重启助手（由 BridgeService.restartDsh 派生为独立进程）。
//
// 为什么需要它：旧进程调用 process.exit(0) 后，端口不会立刻释放；若新进程马上启动，
// 很容易撞上 EADDRINUSE 然后无声退出（stdio 被 ignore 时连报错都看不到），
// 结果就是"点了重启，dsh 再也没起来"。本助手按顺序做三件事并把过程写进日志：
//   1. 等旧进程真正退出；
//   2. 等端口释放（能连上说明还被占着）；
//   3. 才派生新的 dsh，并在最长 120s 内确认端口可连接；失败则记日志并以非 0 退出。
//
// 用法（由 lib/index.js 组装 payload）：node restart-helper.mjs '<json>'
import { spawn } from 'node:child_process';
import { appendFileSync, openSync } from 'node:fs';
import { connect } from 'node:net';

const payload = JSON.parse(process.argv[2] ?? '{}');
const {
  pid, port, argv, cwd, execPath, logFile, childLog,
  // 超时可注入（单测用），生产用默认值
  waitTimeoutMs = 30_000,
  readyTimeoutMs = 120_000,
} = payload;
const startedAt = Date.now();

function log(message) {
  try { appendFileSync(logFile, `[${new Date().toISOString()}] [helper] ${message}\n`); } catch { /* 日志不可写时忽略 */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processAlive(targetPid) {
  try {
    process.kill(targetPid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 端口上是否有人在监听（能建立连接即视为被占用） */
async function portAccepts(portNumber) {
  return await new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let socket;
    try {
      socket = connect({ host: '127.0.0.1', port: portNumber });
    } catch {
      done(false);
      return;
    }
    socket.setTimeout(1200);
    socket.once('connect', () => { done(true); socket.destroy(); });
    socket.once('timeout', () => { done(false); socket.destroy(); });
    socket.once('error', () => { done(false); socket.destroy(); });
  });
}

async function waitUntil(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) {
      log(`等待超时：${label}（${timeoutMs}ms）`);
      return false;
    }
    await sleep(400);
  }
}

async function main() {
  log(`启动：oldPid=${pid} port=${port} cwd=${cwd}`);

  if (!(await waitUntil(() => !processAlive(pid), waitTimeoutMs, `旧进程 ${pid} 退出`))) {
    log('旧进程仍在运行，放弃本次重启（不做任何破坏性动作）');
    process.exit(2);
  }
  if (!(await waitUntil(async () => !(await portAccepts(port)), waitTimeoutMs, `端口 ${port} 释放`))) {
    log(`端口 ${port} 仍被占用，放弃本次重启`);
    process.exit(3);
  }

  let stdio = 'ignore';
  try { stdio = openSync(childLog, 'a'); } catch { /* 打不开就用 ignore */ }
  let child;
  try {
    child = spawn(execPath, argv, { cwd, env: process.env, detached: true, stdio: ['ignore', stdio, stdio] });
  } catch (err) {
    log(`派生新 dsh 失败：${err?.message ?? err}`);
    process.exit(4);
  }
  log(`已派生新 dsh：pid=${child.pid ?? '(未知)'}（输出见 ${childLog}）`);
  child.unref();

  const up = await waitUntil(() => portAccepts(port), readyTimeoutMs, `新 dsh 监听 ${port}`);
  log(up
    ? `✅ 新 dsh 已就绪，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`
    : `❌ 新 dsh 未能在 ${Math.round(readyTimeoutMs / 1000)}s 内就绪，请查看 ${childLog}`);
  process.exit(up ? 0 : 1);
}

void main();
