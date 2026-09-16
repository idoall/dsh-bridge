// 运行时兼容垫片（lib/compat.js）
//
// 背景：DSH 核心依赖链（@deepseek-ai/dsh-timeout ← dsh-llm）在每次 agent 请求上
// 调用 AbortSignal.any([...])，该 API 仅存在于 Node 20.3+/22+。运行在低版本 Node
// （如 Node 18）上时，通过桥接发送消息会直接抛
//   "AbortSignal.any is not a function ... (internal)"
// 本模块在缺失时安装规范兼容的垫片；环境本身支持时不做任何事（返回 false）。
//
// 浏览器侧（旧 Safari/WebView）由 lib/index.js 的 HTML_HEAD_INJECTIONS 注入同语义垫片。

function abortWith(controller, reason) {
  try {
    controller.abort(reason)
  } catch {
    try { controller.abort() } catch { /* 不可中止的信号：忽略 */ }
  }
}

/**
 * 在目标环境中安装 AbortSignal.any / AbortSignal.timeout 垫片（仅缺失时）。
 * @param {object} [target] 可注入的环境（默认 globalThis），便于测试
 * @returns {boolean} 是否实际安装了垫片
 */
export function installAbortSignalCompat(target = globalThis) {
  const Signal = target.AbortSignal
  const Controller = target.AbortController
  if (!Signal || !Controller) return false

  let installed = false

  // ---- AbortSignal.any ----
  if (typeof Signal.any !== 'function') {
    Signal.any = (signals) => {
      const list = Array.from(signals ?? [])
      const controller = new Controller()
      // 规范语义：任一源信号已中止 → 立即以该原因中止
      for (const s of list) {
        if (s && s.aborted) {
          abortWith(controller, s.reason)
          return controller.signal
        }
      }
      const onAbort = (eventOrSignal) => {
        // 真实 EventTarget 的 abort 事件参数是 event（event.target = 信号），
        // 部分非标准实现直接传信号本身——两者都兼容取 reason
        const src = eventOrSignal && eventOrSignal.target ? eventOrSignal.target : eventOrSignal
        cleanup()
        abortWith(controller, src ? src.reason : undefined)
      }
      const cleanup = () => {
        for (const s of list) {
          try { s.removeEventListener('abort', onAbort) } catch { /* 非标准信号：忽略 */ }
        }
      }
      for (const s of list) {
        try { s.addEventListener('abort', onAbort, { once: true }) } catch { /* 非标准信号：忽略 */ }
      }
      return controller.signal
    }
    installed = true
  }

  // ---- AbortSignal.timeout（Node 17.3+ / 较新浏览器才有，顺手补齐）----
  if (typeof Signal.timeout !== 'function') {
    Signal.timeout = (delayMs) => {
      const controller = new Controller()
      const delay = Math.max(0, Number(delayMs) || 0)
      const reason = typeof target.DOMException === 'function'
        ? new target.DOMException('The operation timed out.', 'TimeoutError')
        : new Error('The operation timed out.')
      const timer = setTimeout(() => abortWith(controller, reason), delay)
      // 规范语义：timeout 信号的超时定时器不阻止进程退出
      if (typeof timer.unref === 'function') timer.unref()
      return controller.signal
    }
    installed = true
  }

  return installed
}

/**
 * 浏览器侧垫片源码：由代理注入到 HTML <head>（在宿主所有脚本之前执行），
 * 为 iOS 16 / 旧 Safari / 旧 WebView（无 AbortSignal.any，Safari 17.4 才加入）
 * 上的 DSH 网页客户端补齐。多行可读源码，勿手工压缩成单行（配平易错）。
 */
export const BROWSER_ABORT_SIGNAL_POLYFILL = `<script data-dsh-bridge-polyfill="2">
!function () {
  try {
    var S = self.AbortSignal;
    if (typeof S !== 'function') return;
    if (typeof S.any !== 'function') {
      S.any = function (signals) {
        var list = Array.prototype.slice.call(signals || []);
        var c = new self.AbortController();
        var onAbort = function (ev) {
          var src = ev && ev.target ? ev.target : ev;
          cleanup();
          try { c.abort(src ? src.reason : undefined); } catch (e) { c.abort(); }
        };
        var cleanup = function () {
          for (var i = 0; i < list.length; i++) {
            try { list[i].removeEventListener('abort', onAbort); } catch (e) {}
          }
        };
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].aborted) {
            try { c.abort(list[i].reason); } catch (e) { c.abort(); }
            return c.signal;
          }
        }
        for (var i = 0; i < list.length; i++) {
          try { list[i].addEventListener('abort', onAbort, { once: true }); } catch (e) {}
        }
        return c.signal;
      };
    }
    if (typeof S.timeout !== 'function') {
      S.timeout = function (ms) {
        var c = new self.AbortController();
        setTimeout(function () {
          try { c.abort(new Error('The operation timed out.')); } catch (e) { c.abort(); }
        }, Math.max(0, Number(ms) || 0));
        return c.signal;
      };
    }
  } catch (e) { /* 环境异常时不影响页面其余脚本 */ }
}();
</script>`

/**
 * 浏览器侧垫片源码（二）：iOS 16 / 旧 Safari 缺失的 Promise.withResolvers 与 Iterator。
 *
 * 背景（两者都是"整个 app 起不来"级别）：
 * 1. `Promise.withResolvers`：Safari 17.4+ / Chrome 119+ 才有。DSH 宿主 HTML 末尾的内联脚本
 *    直接写 `(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()`；
 *    另有多个客户端插件在运行期使用（审批、用户提问、cordis 运行时 ctx.timeout/ctx.interval、
 *    workspace-files 的文件变更订阅 Follower）。
 * 2. `Iterator`：Safari 18.4+ 才有（迭代器辅助方法）。DSH 自带的 pdf.js 在**模块顶层**就执行
 *      `if (typeof Iterator.prototype.join !== "function") Iterator.prototype.join = ...`
 *    iOS 16 上没有 Iterator 全局，于是这一行抛 `Can't find variable: Iterator`，
 *    导致 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 导入失败 → 整个插件树加载失败，
 *    页面直接显示 "Failed to load plugins"（实测于 iOS 16 真机 + 本机同构模拟）。
 *    这里把真实的内置迭代器共享原型（%IteratorPrototype%）挂到 `Iterator.prototype` 上，
 *    使 pdf.js 的补丁落到真实迭代器原型，而不是一个无用的空对象。
 *
 * 两者都在缺失时才安装；已有该能力的引擎不做任何事。多行可读源码，勿手工压缩成单行（配平易错）。
 */
export const BROWSER_PROMISE_ITERATOR_POLYFILL = `<script data-dsh-bridge-polyfill="3">
!function () {
  try {
    if (typeof Promise !== 'undefined' && typeof Promise.withResolvers !== 'function') {
      Promise.withResolvers = function () {
        var resolve, reject;
        var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
        return { promise: promise, resolve: resolve, reject: reject };
      };
    }
  } catch (e) { /* 环境异常时不影响页面其余脚本 */ }
  try {
    if (typeof self.Iterator === 'undefined') {
      var proto = null;
      try {
        proto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
      } catch (e2) { proto = null; }
      var IteratorShim = function Iterator() {};
      if (proto && typeof proto === 'object') IteratorShim.prototype = proto;
      self.Iterator = IteratorShim;
    }
  } catch (e) { /* 环境异常时不影响页面其余脚本 */ }
}();
</script>`
