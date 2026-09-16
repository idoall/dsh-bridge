// 回归测试（移动端文档预览「文件资源服务不可用」）：dsh-resource: 地址的 URL 兼容层
//
// 背景：鸿蒙（HuaweiBrowser / ArkWeb）内核对非特殊 scheme 的解析差异会让
// `new URL('dsh-resource://file/…').hostname` 返回空串，而 DSH 的客户端资源注册表
// （@deepseek-ai/dsh-client-resources 的 protocolOf）拿 hostname 当协议键，取不到就把
// 记录判定为"没有 provider"，于是文档预览永远显示「文件资源服务不可用。」。
// 这里用 Node 的 URL 模拟"有差异/无差异"两种引擎，验证 client/resource-url-compat.js：
//   - 引擎正常 → 'not-needed'，且 window.URL 一个字节都不改；
//   - 引擎有差异 → 'installed'，且 dsh-resource 地址能解析出 host，其余语义保持原生。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installResourceUrlCompat } from '../client/resource-url-compat.js';

const FILE_ADDR = 'dsh-resource://file/session/session-abc/client/index.js';

/** 造一个"hostname 对 dsh-resource 返回空串"的 URL 类，模拟鸿蒙内核。
 *  注意：它改的是 **共享的 URL.prototype**，必须用 withQuirkURL() 包起来并保证恢复，
 *  否则会污染同进程的其它用例（这是上一轮验收指出的问题）。 */
function makeQuirkURL() {
  const NativeURL = URL;
  function QuirkURL(...args) {
    return new NativeURL(...args);
  }
  QuirkURL.prototype = NativeURL.prototype;
  for (const key of Object.getOwnPropertyNames(NativeURL)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    try { QuirkURL[key] = NativeURL[key]; } catch { /* ignore */ }
  }
  const hostnameDesc = Object.getOwnPropertyDescriptor(NativeURL.prototype, 'hostname');
  const hostDesc = Object.getOwnPropertyDescriptor(NativeURL.prototype, 'host');
  Object.defineProperty(QuirkURL.prototype, 'hostname', {
    configurable: true,
    enumerable: hostnameDesc.enumerable,
    get() { return this.protocol === 'dsh-resource:' ? '' : hostnameDesc.get.call(this); },
    set: hostnameDesc.set,
  });
  if (hostDesc) {
    Object.defineProperty(QuirkURL.prototype, 'host', {
      configurable: true,
      enumerable: hostDesc.enumerable,
      get() { return this.protocol === 'dsh-resource:' ? '' : hostDesc.get.call(this); },
      set: hostDesc.set,
    });
  }
  return QuirkURL;
}

/** 施加内核差异补丁 → 执行 fn → 无论如何都恢复原生原型，杜绝跨用例污染 */
function withQuirkURL(fn) {
  const originalHostname = Object.getOwnPropertyDescriptor(URL.prototype, 'hostname');
  const originalHost = Object.getOwnPropertyDescriptor(URL.prototype, 'host');
  const quirk = makeQuirkURL();
  try {
    return fn(quirk);
  } finally {
    Object.defineProperty(URL.prototype, 'hostname', originalHostname);
    if (originalHost) Object.defineProperty(URL.prototype, 'host', originalHost);
  }
}

test('正常内核：判定 not-needed 且完全不改动 window.URL', () => {
  const win = { URL };
  const before = win.URL;
  assert.equal(installResourceUrlCompat(win), 'not-needed');
  assert.equal(win.URL, before, '引擎正常时不得包装 URL');
  assert.equal(new win.URL(FILE_ADDR).hostname, 'file');
});

test('无 window / 无 URL：返回 no-url，不抛异常', () => {
  assert.equal(installResourceUrlCompat(undefined), 'no-url');
  assert.equal(installResourceUrlCompat({}), 'no-url');
});

test('鸿蒙式内核差异：安装兼容层并让 dsh-resource 地址解析出 host', () => {
  withQuirkURL((quirk) => {
    const win = { URL: quirk };
    // 前置确认：模拟引擎确实解析不出 host（否则用例本身没意义）
    assert.equal(new win.URL(FILE_ADDR).hostname, '');

    assert.equal(installResourceUrlCompat(win), 'installed');
    const url = new win.URL(FILE_ADDR);
    assert.equal(url.hostname, 'file', '修复后 hostname 必须是 file（注册表据此匹配 provider）');
    assert.equal(url.host, 'file');
    assert.equal(url.protocol, 'dsh-resource:');
    assert.equal(url.pathname, '/session/session-abc/client/index.js', '其余部分必须保持原生解析结果');

    // 有意义的「原型未被破坏」断言：包装器必须沿用原生原型对象。
    // （不能只写 url instanceof URL —— 返回的本来就是原生实例，删掉这行也照样为真，属空断言。）
    assert.equal(win.URL.prototype, URL.prototype, 'CompatURL.prototype 必须指向原生 URL.prototype');
    assert.equal(Object.getPrototypeOf(url), URL.prototype);
  });
});

test('只影响 dsh-resource：其它协议与非资源地址行为不变', () => {
  withQuirkURL((quirk) => {
    const win = { URL: quirk };
    installResourceUrlCompat(win);
    assert.equal(new win.URL('https://example.com/a/b').hostname, 'example.com');
    assert.equal(new win.URL('https://example.com/a/b?q=1#f').search, '?q=1');
    assert.equal(new win.URL('/local/path', 'https://example.com').href, 'https://example.com/local/path');
    assert.equal(String(new win.URL('dsh-resource://file/x/y')), 'dsh-resource://file/x/y');
  });
});

test('兼容层保留 URL 的静态能力，且 hostname/host 读写自洽（不返回陈旧常量）', () => {
  withQuirkURL((quirk) => {
    const win = { URL: quirk };
    installResourceUrlCompat(win);
    assert.equal(typeof win.URL.canParse, 'function');
    assert.equal(win.URL.canParse(FILE_ADDR), true);
    // 静态方法应原样透传（同一引用）
    assert.equal(win.URL.createObjectURL, URL.createObjectURL);
    assert.equal(win.URL.revokeObjectURL, URL.revokeObjectURL);

    const url = new win.URL(FILE_ADDR);
    assert.equal(url.hostname, 'file');
    // 写入后必须读回新值（getter 不能缓存常量）
    url.hostname = 'other';
    assert.equal(url.hostname, 'other', '赋值 hostname 后读回必须是新值');
    // 改 href 后也必须立刻反映新 host（尤其是另一个 dsh-resource 地址）
    const again = new win.URL(FILE_ADDR);
    again.href = 'dsh-resource://other/file.txt';
    assert.equal(again.hostname, 'other', '改 href 后读回必须是新 host');
  });
});

test('地址里没有 host 时不强行编造（保持原生结果）', () => {
  withQuirkURL((quirk) => {
    const win = { URL: quirk };
    installResourceUrlCompat(win);
    assert.equal(new win.URL('dsh-resource:///file/x').hostname, '');
  });
});
