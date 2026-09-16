// AbortSignal 兼容垫片回归测试（移动端发消息报 AbortSignal.any is not a function）
//
// 真实场景有两个面：
// 1. 服务端：低版本 Node（<20.3）运行 DSH 时，@deepseek-ai/dsh-timeout 在每次
//    agent 请求上调用 AbortSignal.any 直接抛错（Node 24 本身有该 API，须用假环境
//    覆盖"缺失 → 安装 → 行为正确"链路）；
// 2. 浏览器端：iOS 16 的 Safari/WKWebView 没有 AbortSignal.any（Safari 17.4 才加入），
//    DSH 网页客户端发消息即崩 —— 由代理注入 BROWSER_ABORT_SIGNAL_POLYFILL 修复，
//    注入脚本在 vm 沙箱里用真实 AbortController 做真实行为验证。
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { installAbortSignalCompat, BROWSER_ABORT_SIGNAL_POLYFILL, BROWSER_PROMISE_ITERATOR_POLYFILL } from '../lib/compat.js'

/** 构造一个没有 any/timeout 的最小 AbortSignal/AbortController 环境 */
function makeLegacyEnvironment() {
  class FakeSignal {
    constructor() {
      this.aborted = false
      this.reason = undefined
      this._listeners = []
    }
    addEventListener(type, fn) { if (type === 'abort') this._listeners.push(fn) }
    removeEventListener(type, fn) { this._listeners = this._listeners.filter((l) => l !== fn) }
  }
  class FakeController {
    constructor() {
      this.signal = new FakeSignal()
    }
    abort(reason) {
      if (this.signal.aborted) return
      this.signal.aborted = true
      this.signal.reason = reason
      for (const fn of [...this.signal._listeners]) fn(this.signal)
    }
  }
  const target = { AbortSignal: FakeSignal, AbortController: FakeController }
  return { target }
}

test('垫片在缺失 AbortSignal.any 时安装并返回 true，在已有时不重复安装', () => {
  const legacy = makeLegacyEnvironment()
  assert.equal(installAbortSignalCompat(legacy.target), true)
  assert.equal(typeof legacy.target.AbortSignal.any, 'function')
  assert.equal(typeof legacy.target.AbortSignal.timeout, 'function')

  // 现代环境（本测试运行于 Node 24，any 已存在）→ 不做任何事
  assert.equal(installAbortSignalCompat(globalThis), false)
})

test('垫片 any()：任一源信号中止时组合信号以相同 reason 中止', async () => {
  const { target } = makeLegacyEnvironment()
  installAbortSignalCompat(target)

  const controller = new target.AbortController()
  const combined = target.AbortSignal.any([controller.signal, target.AbortSignal.timeout(60_000)])
  assert.equal(combined.aborted, false)

  controller.abort(new Error('user cancelled'))
  assert.equal(combined.aborted, true)
  assert.match(String(combined.reason), /user cancelled/)
})

test('垫片 any()：timeout 信号到时后中止组合信号', async () => {
  const { target } = makeLegacyEnvironment()
  installAbortSignalCompat(target)

  const upstream = new target.AbortController()
  const combined = target.AbortSignal.any([upstream.signal, target.AbortSignal.timeout(20)])
  assert.equal(combined.aborted, false)

  await new Promise((r) => setTimeout(r, 80))
  assert.equal(combined.aborted, true, 'timeout 到期必须中止组合信号')
})

test('垫片 any()：已中止的源信号立即中止返回值（规范语义）', () => {
  const { target } = makeLegacyEnvironment()
  installAbortSignalCompat(target)

  const done = new target.AbortController()
  done.abort('already')
  const combined = target.AbortSignal.any([done.signal])
  assert.equal(combined.aborted, true)
  assert.match(String(combined.reason), /already/)
})

test('垫片 any()：空数组与非信号元素安全处理', () => {
  const { target } = makeLegacyEnvironment()
  installAbortSignalCompat(target)

  const empty = target.AbortSignal.any([])
  assert.equal(empty.aborted, false)

  const tolerant = target.AbortSignal.any([null, undefined])
  assert.equal(tolerant.aborted, false)
})

test('垫片 timeout()：到时中止且 reason 携带超时语义', async () => {
  const { target } = makeLegacyEnvironment()
  installAbortSignalCompat(target)

  const signal = target.AbortSignal.timeout(20)
  assert.equal(signal.aborted, false)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(signal.aborted, true)
  assert.ok(signal.reason)
})

// ---------------------------------------------------------------------------
// 浏览器注入垫片（iOS 16 / 旧 Safari 无 AbortSignal.any）
// ---------------------------------------------------------------------------

/** 把注入脚本放进 vm 沙箱执行：AbortSignal 用不含 any 的壳函数模拟旧浏览器 */
function runBrowserPolyfillInSandbox() {
  // 壳构造器不链接到真实 AbortSignal 原型 → typeof S.any 为 undefined（模拟旧浏览器）
  const LegacySignalShell = function LegacySignalShell() {}
  const sandbox = {
    self: null,
    AbortController, // 真实 AbortController：事件派发行为与浏览器一致
    AbortSignal: LegacySignalShell,
    setTimeout,
    clearTimeout,
  }
  sandbox.self = sandbox
  vm.createContext(sandbox)

  const scriptBody = BROWSER_ABORT_SIGNAL_POLYFILL
    .replace('<script data-dsh-bridge-polyfill="2">', '')
    .replace('</script>', '')
  new Function(scriptBody) // 语法编译校验（浏览器里语法错误会导致整个脚本失效）

  vm.runInContext(scriptBody, sandbox)
  return sandbox
}

test('浏览器注入垫片：旧浏览器环境安装 any/timeout 且组合行为正确', async () => {
  const sandbox = runBrowserPolyfillInSandbox()
  assert.equal(typeof sandbox.AbortSignal.any, 'function', '垫片必须安装 S.any')
  assert.equal(typeof sandbox.AbortSignal.timeout, 'function')

  // 用真实 AbortController 验证组合语义（与 iOS 浏览器中的真实用法一致）
  const upstream = new AbortController()
  const combined = sandbox.AbortSignal.any([upstream.signal, sandbox.AbortSignal.timeout(60_000)])
  assert.equal(combined.aborted, false)
  upstream.abort(new Error('user cancelled'))
  assert.equal(combined.aborted, true)
  assert.match(String(combined.reason), /user cancelled/)

  const timed = sandbox.AbortSignal.timeout(20)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(timed.aborted, true)
})

test('代理注入的 HTML 包含 AbortSignal 垫片（端到端）', async () => {
  const { createServer } = await import('node:http')
  const { ProxyServer } = await import('../lib/index.js')
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><head><title>probe</title></head><body>ok</body></html>')
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const proxy = new ProxyServer({
    localPort: 0, targetPort: upstream.address().port, authManager: null,
    logger: { info() {}, warn() {}, error() {} },
  })
  await proxy.start()
  try {
    const port = proxy.server.address().port
    const res = await fetch(`http://127.0.0.1:${port}/`)
    const html = await res.text()
    assert.ok(html.includes('data-dsh-bridge-polyfill="2"'), '必须注入 AbortSignal 垫片脚本')
    assert.ok(html.includes('S.any ='), '垫片必须补齐 any')
    assert.ok(html.includes('data-dsh-bridge-polyfill="3"'), '必须注入 iOS 16 的 Promise/Iterator 垫片')
    assert.ok(html.includes('Promise.withResolvers ='), '垫片必须补齐 Promise.withResolvers')
    assert.ok(html.includes('self.Iterator = IteratorShim'), '垫片必须补齐 Iterator')
    // 垫片脚本必须位于 <head> 内、宿主页面内容之前，才能在宿主脚本执行前生效
    assert.ok(html.indexOf('data-dsh-bridge-polyfill="2"') < html.indexOf('<title>probe</title>'), '垫片须在宿主内容之前')
    assert.ok(html.indexOf('data-dsh-bridge-polyfill="3"') < html.indexOf('<title>probe</title>'), 'iOS 16 垫片须在宿主内容之前')
    assert.ok(html.includes('<title>probe</title>'), '原页面内容保留')
  } finally {
    await proxy.stop()
    await new Promise((r) => upstream.close(r))
  }
})

// ---------------------------------------------------------------------------
// 浏览器注入垫片（二）：iOS 16 / 旧 Safari 无 Promise.withResolvers、无 Iterator 全局
// ---------------------------------------------------------------------------

function polyfillBody(source) {
  return source.replace(/<script[^>]*>/, '').replace('</script>', '')
}

/** 在 vm 沙箱里跑 iOS 16 垫片：删掉 withResolvers 与 Iterator，模拟 iOS 16 Safari */
function runIos16PolyfillInSandbox({ withIterator = false } = {}) {
  const sandbox = { self: null }
  sandbox.self = sandbox
  vm.createContext(sandbox)
  // 沙箱是新 realm：先摘掉 withResolvers，Iterator 本来就不存在（除非显式造一个）
  vm.runInContext('if (typeof Promise.withResolvers === "function") delete Promise.withResolvers;', sandbox)
  if (withIterator) {
    vm.runInContext('self.Iterator = function Iterator() {}; self.Iterator.__sentinel = 1;', sandbox)
  }
  const body = polyfillBody(BROWSER_PROMISE_ITERATOR_POLYFILL)
  new Function(body) // 语法编译校验（浏览器里语法错误会导致整个脚本失效）
  vm.runInContext(body, sandbox)
  return sandbox
}

test('iOS 16 垫片：补齐 Promise.withResolvers 且语义正确', async () => {
  const sandbox = runIos16PolyfillInSandbox()
  const installed = vm.runInContext('typeof Promise.withResolvers', sandbox)
  assert.equal(installed, 'function', '必须安装 Promise.withResolvers')

  const resolved = vm.runInContext(`(function () {
    var d = Promise.withResolvers();
    var seen = null;
    d.promise.then(function (v) { seen = v; });
    d.resolve(42);
    return { thenable: typeof d.promise.then === 'function', hasReject: typeof d.reject === 'function' };
  })()`, sandbox)
  assert.equal(resolved.thenable, true)
  assert.equal(resolved.hasReject, true)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(await vm.runInContext(`(function () {
    var d = Promise.withResolvers();
    d.resolve('ok');
    return d.promise;
  })()`, sandbox), 'ok', 'resolve 必须能真正兑现 promise')
})

test('iOS 16 垫片：Iterator.prototype 必须指向真实的内置迭代器共享原型', () => {
  const sandbox = runIos16PolyfillInSandbox()
  assert.equal(vm.runInContext('typeof self.Iterator', sandbox), 'function', '必须安装 Iterator')

  // pdf.js 在模块顶层就写 Iterator.prototype.join = ...（它以为 Iterator 存在）。
  // 只有当 Iterator.prototype 是真实 %IteratorPrototype% 时，这个补丁才对内置迭代器生效。
  const joined = vm.runInContext(`(function () {
    if (typeof Iterator.prototype.join !== 'function') {
      Iterator.prototype.join = function (sep) { return Array.prototype.join.call(Array.from(this), sep); };
    }
    return [1, 2, 3].values().join('-');
  })()`, sandbox)
  assert.equal(joined, '1-2-3', '补丁必须落到真实迭代器原型（否则 pdf.js 的 join 兜底形同虚设）')
})

test('iOS 16 垫片：引擎已具备时不改动既有实现', () => {
  const sandbox = runIos16PolyfillInSandbox({ withIterator: true })
  assert.equal(vm.runInContext('self.Iterator.__sentinel', sandbox), 1, '已有 Iterator 时不得覆盖')
  const withResolversKept = vm.runInContext(`(function () {
    var native = function () { return 'native'; };
    Promise.withResolvers = native;
    return Promise.withResolvers === native;
  })()`, sandbox)
  assert.equal(withResolversKept, true, '已有 withResolvers 时不得覆盖')
})
