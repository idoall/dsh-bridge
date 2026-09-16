// 重启助手（lib/restart-helper.mjs）端到端测试。
//
// 事故背景：旧进程 process.exit(0) 后端口不会立刻释放，新进程马上启动容易撞 EADDRINUSE 后
// 无声退出（stdio 被 ignore，连报错都看不到）→「点了重启，dsh 再也没起来」。
// 助手必须：等旧进程退出 → 等端口释放 → 才拉起新进程 → 确认端口可连接 → 全过程写日志。
//
// 这里用两个真实的 Node 进程模拟"旧 dsh / 新 dsh"（各自监听一个真实端口）来做真实行为验证，
// 不使用 mock；结束后按日志里记录的 pid 清理新进程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'restart-helper.mjs');

/** 占一个空闲端口后立刻释放，得到一个大概率可用的端口号 */
async function pickFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function portAccepts(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (v) => { try { socket.destroy(); } catch { /* ignore */ } resolve(v); };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const LISTEN_SCRIPT = 'const net=require("net");const s=net.createServer();s.listen(Number(process.argv[1]),"127.0.0.1");';

test('重启助手：等旧进程退出与端口释放后才拉起新进程，并确认端口可连接', async () => {
  const port = await pickFreePort();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-helper-'));
  const logFile = join(dir, 'restart.log');
  const childLog = join(dir, 'restart-child.log');

  // "旧 dsh"：真实占用端口
  const oldProc = spawn(process.execPath, ['-e', LISTEN_SCRIPT, String(port)], { stdio: 'ignore' });
  assert.ok(await waitFor(() => portAccepts(port), 5000), '旧进程应已监听');

  const payload = JSON.stringify({
    pid: oldProc.pid,
    port,
    argv: ['-e', LISTEN_SCRIPT, String(port)],
    cwd: process.cwd(),
    execPath: process.execPath,
    logFile,
    childLog,
  });
  const helper = spawn(process.execPath, [HELPER, payload], { stdio: 'ignore' });

  // 旧进程在助手等待期间退出（模拟真实重启：旧 dsh 收到重启请求后退出）
  setTimeout(() => { try { oldProc.kill('SIGKILL'); } catch { /* ignore */ } }, 400);

  const exitCode = await new Promise((resolve) => helper.once('exit', resolve));
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';

  assert.equal(exitCode, 0, `助手应以 0 退出，实际 ${exitCode}\n日志:\n${log}`);
  assert.match(log, /已派生新 dsh/, '日志必须记录派生动作');
  assert.match(log, /✅ 新 dsh 已就绪/, '日志必须记录"已就绪"验证结果');
  assert.ok(await waitFor(() => portAccepts(port), 5000), '新进程应监听同一端口');

  // 清理新进程：从日志里取 pid
  const pidMatch = /已派生新 dsh：pid=(\d+)/.exec(log);
  if (pidMatch) {
    try { process.kill(Number(pidMatch[1]), 'SIGKILL'); } catch { /* 可能已退出 */ }
  }
});

test('重启助手：新进程派生失败（execPath 不存在）→ rc=4 且日志写明原因（R-C 回归）', async () => {
  const port = await pickFreePort();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-helper-err-'));
  const logFile = join(dir, 'restart.log');
  const childLog = join(dir, 'restart-child.log');

  const payload = JSON.stringify({
    pid: 999_999_999,            // 不存在的 pid → 直接进入"等端口释放"（端口本来就空闲）
    port,
    argv: ['-e', '/* 不会被执行 */'],
    cwd: process.cwd(),
    execPath: join(dir, 'definitely-not-a-real-node-binary'),
    logFile,
    childLog,
    waitTimeoutMs: 1500,
    readyTimeoutMs: 1500,
  });
  const helper = spawn(process.execPath, [HELPER, payload], { stdio: 'ignore' });
  const exitCode = await new Promise((resolve) => helper.once('exit', resolve));
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';

  assert.equal(exitCode, 4, `派生失败应以 4 退出，实际 ${exitCode}\n日志:\n${log}`);
  assert.match(log, /派生新 dsh 失败/, '日志必须写明派生失败');
  assert.match(log, /ENOENT|no such file/i, '日志必须带可诊断原因（不能只留"已派生 pid=(未知)"）');
  assert.doesNotMatch(log, /已派生新 dsh/, '确认成功前不得写"已派生"');
});

test('重启助手：端口一直被占用时放弃重启（不盲目拉起第二个实例）', async () => {
  const port = await pickFreePort();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-helper-blocked-'));
  const logFile = join(dir, 'restart.log');
  const childLog = join(dir, 'restart-child.log');

  // 端口占着不放（pid 用一个已退出进程，让助手跳过"等旧进程退出"这一步）
  const holder = spawn(process.execPath, ['-e', LISTEN_SCRIPT, String(port)], { stdio: 'ignore' });
  assert.ok(await waitFor(() => portAccepts(port), 5000));

  const payload = JSON.stringify({
    pid: 999_999_999, // 不存在的 pid → alive 判定为 false，直接进入"等端口释放"
    port,
    argv: ['-e', LISTEN_SCRIPT, String(port)],
    cwd: process.cwd(),
    execPath: process.execPath,
    logFile,
    childLog,
    waitTimeoutMs: 1500, // 单测缩短"等端口释放"的超时
  });
  const helper = spawn(process.execPath, [HELPER, payload], { stdio: 'ignore' });
  const exitCode = await new Promise((resolve) => helper.once('exit', resolve));
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';

  assert.equal(exitCode, 3, `端口未释放应以 3 退出，实际 ${exitCode}\n日志:\n${log}`);
  assert.match(log, /仍被占用，放弃本次重启/);
  assert.doesNotMatch(log, /已派生新 dsh/, '不得在端口仍被占用时拉起新实例');

  try { holder.kill('SIGKILL'); } catch { /* ignore */ }
});
