// 资源地址方言兼容（鸿蒙 ArkWeb / HuaweiBrowser 等内核对非特殊 scheme 的 URL 解析差异）
//
// 现象：某些内核里 `new URL('dsh-resource://file/session/<id>/<path>').hostname` 返回空串，
// 而 Chrome/Safari 返回 "file"。DSH 的客户端资源注册表 `@deepseek-ai/dsh-client-resources`
// 恰好用 URL 的 hostname 当"协议键"（protocolOf），取不到就把该资源的记录判定成"没有 provider"：
//   - 记录创建时 protocol 为 undefined → 状态永远停在 "none"；
//   - 注册表只在 provider 注册时把已有记录重新挂载一次，之后不会重试 → 刷新也不会恢复；
// 表现即：右侧栏文件 / 对话里生成的文档预览永远显示「文件资源服务不可用。」，而
// `resources.providers` 里其实是有 "file" 的（宿主 @deepseek-ai/dsh-api-workspace-files 的
// provider 注册成功，坏掉的只是地址解析这一步）。鸿蒙（HuaweiBrowser / ArkWeb 7.0）实测复现。
//
// 处理：**先做特性探测**，只有在该引擎确有差异时才包一层 `window.URL`，并且只对
// `dsh-resource:` 协议、且原生 hostname 为空、且原始串能解析出 host 的实例补一个兜底
// hostname/host（写成实例自有访问器，setter 仍委托原生原型，避免影响赋值语义）。
// 引擎正常时完全不改动 URL（返回 'not-needed'）。
//
// 说明：根因在宿主侧（DSH 用 URL.hostname 当协议键），此处是桥侧最小兜底；
// 宿主上游若改为从原始串解析协议，本模块会自动进入 'not-needed' 分支、不再介入。

/**
 * 安装 `dsh-resource:` 地址的 URL 兼容层。
 *
 * @param {object} [win] 便于测试注入的 window（默认取全局 window）
 * @returns {'not-needed'|'installed'|'no-url'|'probe-throw'} 本次的处理结果
 *   - `not-needed`：引擎解析正常，未做任何改动
 *   - `installed`：引擎有差异，已包装 window.URL
 *   - `no-url` / `probe-throw`：环境不适用（无 window.URL / 构造探测失败）
 */
export function installResourceUrlCompat(win = typeof window === 'undefined' ? undefined : window) {
  if (!win || typeof win.URL !== 'function') return 'no-url';
  const NativeURL = win.URL;
  let probe;
  try {
    probe = new NativeURL('dsh-resource://file/__dsh_probe__/x');
  } catch {
    return 'probe-throw';
  }
  if (probe.hostname === 'file') return 'not-needed';

  const hostOf = (raw) => {
    const m = /^dsh-resource:\/\/([^/?#]*)/i.exec(String(raw || ''));
    return m && m[1] ? m[1].toLowerCase() : '';
  };

  function CompatURL(...args) {
    const url = new NativeURL(...args);
    try {
      if (String(url.protocol) === 'dsh-resource:' && !url.hostname) {
        const proto = NativeURL.prototype;
        const hostnameDesc = Object.getOwnPropertyDescriptor(proto, 'hostname');
        const hostDesc = Object.getOwnPropertyDescriptor(proto, 'host');
        // 读取顺序：原生解析结果优先（赋值/改 href 后立即反映新值），为空才回退到"从当前 href 现解析"。
        // 不能缓存成常量，否则 u.hostname='x' 或 u.href=... 之后读回仍是陈旧值（getter/setter 不自洽）。
        const hostOfUrl = (u) => {
          let native;
          try { native = hostnameDesc && hostnameDesc.get ? hostnameDesc.get.call(u) : (u.hostname || ''); } catch { native = ''; }
          if (native) return native;
          let href;
          try { href = String(u.href); } catch { href = ''; }
          return hostOf(href);
        };
        if (hostOfUrl(url)) {
          Object.defineProperty(url, 'hostname', {
            configurable: true,
            enumerable: hostnameDesc ? hostnameDesc.enumerable : true,
            get: () => hostOfUrl(url),
            set: (v) => { if (hostnameDesc && hostnameDesc.set) hostnameDesc.set.call(url, v); },
          });
          if (hostDesc) {
            Object.defineProperty(url, 'host', {
              configurable: true,
              enumerable: hostDesc.enumerable,
              get: () => hostOfUrl(url),
              set: (v) => { if (hostDesc.set) hostDesc.set.call(url, v); },
            });
          }
        }
      }
    } catch { /* 兜底失败就保持原生行为 */ }
    return url;
  }

  CompatURL.prototype = NativeURL.prototype;
  for (const key of Object.getOwnPropertyNames(NativeURL)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    try { CompatURL[key] = NativeURL[key]; } catch { /* 只读静态属性忽略 */ }
  }
  win.URL = CompatURL;
  return 'installed';
}
