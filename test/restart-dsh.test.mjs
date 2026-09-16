import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BridgeService, detectSupervisor, parseSystemdUnit } from '../lib/index.js';
import { BRIDGE_ENDPOINTS } from '../lib/bridge-rpc-constants.js';

test('BridgeService restartDsh returns confirmation message', async () => {
  const service = new BridgeService({
    dshPort: 3080,
    proxyPort: 3082,
    logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
  });

  assert.equal(BRIDGE_ENDPOINTS.restartDsh, 'restartDsh');
  assert.equal(typeof service.restartDsh, 'function');
});

// ---------------------------------------------------------------------------
// 事故回归：systemd 用户单元下"自派生子进程 + exit(0)"必然失败
//   - Restart=on-failure 不认干净退出的 code 0；
//   - 默认 KillMode=control-group 会把刚派生的子进程一起杀掉。
// 因此必须先识别 systemd 并把重启交给 systemctl。
// ---------------------------------------------------------------------------

const USER_CGROUP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service';
const SYSTEM_CGROUP = '0::/system.slice/dsh.service';

/**
 * 造一个够用的 spawn 替身：记录调用，并按第几次调用决定发 'spawn' 还是 'error'。
 * @param {object} [opts]
 * @param {number[]} [opts.errorCalls] 需要以 'error' 结束的调用序号（从 0 起）
 */
function makeFakeSpawn({ errorCalls = [], closeCodes = {} } = {}) {
  const calls = [];
  const impl = (command, args, options) => {
    const index = calls.length;
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    const shouldError = errorCalls.includes(index);
    const code = closeCodes[index] ?? 0;
    queueMicrotask(() => {
      if (shouldError) {
        child.emit('error', new Error(`spawn ${command} ENOENT`));
        return;
      }
      child.emit('spawn');
      child.emit('close', code); // 真实子进程（含 systemctl）都会 close
    });
    return child;
  };
  return { impl, calls };
}

function makeService() {
  return new BridgeService({
    dshPort: 3080,
    proxyPort: 3082,
    logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
  });
}

test('parseSystemdUnit 取最内层单元（不能被祖先的 user@1000.service 骗到）', () => {
  assert.equal(parseSystemdUnit(USER_CGROUP), 'dsh-web.service');
  assert.equal(parseSystemdUnit(SYSTEM_CGROUP), 'dsh.service');
  assert.equal(parseSystemdUnit('0::/'), '');
  assert.equal(parseSystemdUnit(''), '');
  // 最内层不是 .service（容器目录 / scope）→ 判空，绝不能向上游取祖先单元
  assert.equal(parseSystemdUnit('0::/system.slice/docker.service/docker/abc123'), '');
  assert.equal(parseSystemdUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-abc.scope'), '');
  assert.equal(parseSystemdUnit('0::/kubepods.slice/kubepods-burstable.slice/cri-containerd-abc.scope'), '');
});

test('detectSupervisor 正确识别 systemd(用户/系统)、守护进程与无托管器', () => {
  assert.deepEqual(
    detectSupervisor({ env: { INVOCATION_ID: 'abc' }, cgroup: USER_CGROUP }),
    { kind: 'systemd', scope: 'user', unit: 'dsh-web.service', reason: 'cgroup 检出 systemd 单元' },
  );
  assert.deepEqual(
    detectSupervisor({ env: { JOURNAL_STREAM: '8:1' }, cgroup: SYSTEM_CGROUP }),
    { kind: 'systemd', scope: 'system', unit: 'dsh.service', reason: 'cgroup 检出 systemd 单元' },
  );
  assert.equal(detectSupervisor({ env: { PM2_HOME: '/x' }, cgroup: '' }).kind, 'daemon');
  assert.equal(detectSupervisor({ env: { DSH_DAEMON: '1' }, cgroup: '' }).kind, 'daemon');
  assert.equal(detectSupervisor({ env: {}, cgroup: '' }).kind, 'self');
  // cgroup 里出现 .slice/<unit>.service 就按 systemd 处理（错判也有 systemctl 失败后的助手兜底）
  assert.equal(detectSupervisor({ env: {}, cgroup: '0::/some.slice/weird.service' }).kind, 'systemd');
  // 容器/裸进程形态（无 .slice、无 systemd 标记）→ 自派生
  assert.equal(detectSupervisor({ env: {}, cgroup: '0::/docker/abc123' }).kind, 'self');
});

test('systemd 环境下：走 systemctl --user restart --no-block <unit>，不再自派生', async () => {
  const service = makeService();
  const { impl, calls } = makeFakeSpawn();
  const exits = [];
  const result = await service.restartDsh({
    env: { INVOCATION_ID: 'abc' },
    cgroup: USER_CGROUP,
    spawnImpl: impl,
    scheduleExit: (ms) => exits.push(ms),
  });

  assert.equal(result.ok, true);
  assert.match(result.message, /dsh-web\.service/, '提示里必须点名单元');
  assert.equal(calls.length, 1, '不应再派生自己的子进程');
  assert.equal(calls[0].command, 'systemctl');
  assert.deepEqual(calls[0].args, ['--user', 'restart', '--no-block', 'dsh-web.service']);
  assert.equal(calls[0].options.detached, true);
  assert.deepEqual(exits, [1500], '请求发出后才安排退出');
});

test('system 单元：不带 --user', async () => {
  const service = makeService();
  const { impl, calls } = makeFakeSpawn();
  await service.restartDsh({
    env: { JOURNAL_STREAM: '8:1' },
    cgroup: SYSTEM_CGROUP,
    spawnImpl: impl,
    scheduleExit: () => {},
  });
  assert.deepEqual(calls[0].args, ['restart', '--no-block', 'dsh.service']);
});

test('systemctl 非 0 退出：ok:false、进程不退出、也绝不退化自派生（R-D/R-E 回归）', async () => {
  const service = makeService();
  const { impl, calls } = makeFakeSpawn({ closeCodes: { 0: 5 } }); // 单元不存在 → rc=5
  const exits = [];
  const result = await service.restartDsh({
    env: { INVOCATION_ID: 'abc' },
    cgroup: USER_CGROUP,
    spawnImpl: impl,
    scheduleExit: (ms) => exits.push(ms),
  });

  assert.equal(calls.length, 1, 'systemd 下失败不得退化为自派生（KillMode=control-group 会连助手一起杀）');
  assert.equal(result.ok, false, '必须如实报失败');
  assert.match(result.error, /退出码 5/);
  assert.match(result.error, /DSH 仍在运行/, '必须说明没有做破坏性退出');
  assert.deepEqual(exits, [], '不得安排退出（否则干净退出不会被 systemd 拉起）');
});

test('systemctl 派生失败（error 事件）：同样 ok:false 且不退出、不退化', async () => {
  const service = makeService();
  const { impl, calls } = makeFakeSpawn({ errorCalls: [0] });
  const exits = [];
  const result = await service.restartDsh({
    env: { INVOCATION_ID: 'abc' },
    cgroup: USER_CGROUP,
    spawnImpl: impl,
    scheduleExit: (ms) => exits.push(ms),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT|失败/);
  assert.deepEqual(exits, []);
});

test('无托管器：派生独立助手，payload 带旧 pid 与端口', async () => {
  const service = makeService();
  const { impl, calls } = makeFakeSpawn();
  const result = await service.restartDsh({ env: {}, cgroup: '', spawnImpl: impl, scheduleExit: () => {} });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  const payload = JSON.parse(calls[0].args[1]);
  assert.equal(payload.pid, process.pid);
  assert.equal(payload.port, 3080, '助手要等的是 DSH 端口（targetPort）');
  assert.ok(Array.isArray(payload.argv) && payload.argv.length > 0);
  assert.match(payload.logFile, /restart\.log$/);
});

test('派生助手都失败：返回 ok:false（前端必须报错而不是假装重连）', async () => {
  const service = makeService();
  const throwingSpawn = () => { throw new Error('EACCES'); };
  const result = await service.restartDsh({ env: {}, cgroup: '', spawnImpl: throwingSpawn, scheduleExit: () => {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /EACCES/);
  assert.match(result.error, /仍在运行/, '必须说明没有做破坏性退出');
});
