/**
 * 设备检查插件的纯逻辑用例。
 *
 * 重点不在「函数能跑」,而在**外部格式被钉住**:`adb devices -l` 的字段、`/proc/net/unix` 的列、
 * `/json` 的字段名、以及 devtools 前端的 `ws=` 参数形态。这些格式一变,真机上就是「列表空的」
 * 这种最难查的现象,所以每个格式都在这里留一份真实样本。
 */

import { describe, expect, it } from 'vitest'
import {
  adbArgv,
  adbDevicesArgv,
  adbForwardAddArgv,
  adbForwardRemoveArgv,
  adbSocketsArgv,
  androidPackageFromVersion,
  browserNameFromVersion,
  DEFAULT_ADB_COMMAND,
  effectiveStrategy,
  firstSuggestedFrontendUrl,
  FRONTEND_STORAGE_KEY_MIN_MAJOR,
  frontendNotice,
  frontendUrlFor,
  isWslAdb,
  needsDeviceFrontend,
  normalizeSocketName,
  normalizeStrategy,
  parseAdbSetting,
  parseBrowserMajor,
  parseDevices,
  parseForwardList,
  parseSockets,
  problemHint,
  rewriteWsUrl,
  socketLabel,
  sortTargets,
  splitTargetKey,
  splitTokens,
  suggestedFrontendUrl,
  targetKey,
  targetsFromJson,
  targetTypeLabel,
  wsPathOf,
  type DeviceTarget,
  type DiscoverProblem
} from '../src/plugins/device-inspect/shared'
import { devtoolsFrontendUrl, isDevToolsFrontendUrl, wsParamOf } from '../src/shared/devtools'

// ---------------------------------------------------------------- adb 命令

describe('parseAdbSetting:复合命令', () => {
  it('空值回落成裸 adb', () => {
    expect(parseAdbSetting('')).toEqual({ file: 'adb', prefix: [] })
    expect(parseAdbSetting(undefined)).toEqual({ file: 'adb', prefix: [] })
    expect(parseAdbSetting('   ')).toEqual(DEFAULT_ADB_COMMAND)
  })

  it('本机形态:bow 在 Windows、adb 在 WSL', () => {
    expect(parseAdbSetting('wsl adb')).toEqual({ file: 'wsl', prefix: ['adb'] })
    expect(parseAdbSetting('wsl -d Ubuntu-24.04 adb')).toEqual({
      file: 'wsl',
      prefix: ['-d', 'Ubuntu-24.04', 'adb']
    })
  })

  it('路径带空格用双引号包起来', () => {
    expect(splitTokens('"C:\\Program Files\\platform-tools\\adb.exe"')).toEqual([
      'C:\\Program Files\\platform-tools\\adb.exe'
    ])
    expect(parseAdbSetting('"/opt/Android SDK/adb" -H 127.0.0.1')).toEqual({
      file: '/opt/Android SDK/adb',
      prefix: ['-H', '127.0.0.1']
    })
  })

  it('多个连续空白不会产生空 token', () => {
    expect(splitTokens('  wsl    adb  ')).toEqual(['wsl', 'adb'])
  })
})

describe('adb 参数拼装', () => {
  it('前缀参数永远排在真正的子命令之前', () => {
    expect(adbDevicesArgv({ file: 'wsl', prefix: ['adb'] })).toEqual(['adb', 'devices', '-l'])
    expect(adbArgv({ file: 'adb', prefix: [] }, ['version'])).toEqual(['version'])
  })

  it('套接字枚举走 -s <serial> shell cat /proc/net/unix', () => {
    expect(adbSocketsArgv(DEFAULT_ADB_COMMAND, 'R58M1')).toEqual([
      '-s',
      'R58M1',
      'shell',
      'cat /proc/net/unix'
    ])
  })

  it('转发用 localabstract:,回收用 --remove', () => {
    expect(adbForwardAddArgv(DEFAULT_ADB_COMMAND, 'R58M1', 9301, 'webview_devtools_remote_7')).toEqual([
      '-s',
      'R58M1',
      'forward',
      'tcp:9301',
      'localabstract:webview_devtools_remote_7'
    ])
    expect(adbForwardRemoveArgv(DEFAULT_ADB_COMMAND, 'R58M1', 9301)).toEqual([
      '-s',
      'R58M1',
      'forward',
      '--remove',
      'tcp:9301'
    ])
  })
})

// ---------------------------------------------------------------- adb 输出

describe('parseDevices', () => {
  const sample = [
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    'List of devices attached',
    'R58M12ABCDE            device product:beyond1ltexx model:SM_G973F device:beyond1 transport_id:3',
    '192.168.1.5:5555       device product:x1 model:Pixel_6 device:x2 transport_id:4',
    'ABC123XYZ              unauthorized transport_id:5',
    'EMULATOR5554           offline',
    '',
    ''
  ].join('\n')

  it('解析出串号 / 状态 / 型号,提示行被忽略', () => {
    const devices = parseDevices(sample)
    expect(devices.map((d) => d.serial)).toEqual([
      'R58M12ABCDE',
      '192.168.1.5:5555',
      'ABC123XYZ',
      'EMULATOR5554'
    ])
    expect(devices[0]).toEqual({
      serial: 'R58M12ABCDE',
      state: 'device',
      model: 'SM_G973F',
      product: 'beyond1ltexx',
      transportId: '3'
    })
  })

  it('无线调试的设备(host:port)与 USB 设备同等对待', () => {
    const [, wireless] = parseDevices(sample)
    expect(wireless.state).toBe('device')
    expect(wireless.model).toBe('Pixel_6')
  })

  it('unauthorized / offline / 未知状态都如实上报,不假装成可用', () => {
    const states = parseDevices(sample).map((d) => d.state)
    expect(states).toEqual(['device', 'device', 'unauthorized', 'offline'])
    expect(parseDevices('S1 goofy')[0].state).toBe('unknown')
  })

  it('空输出与只有表头都返回空数组', () => {
    expect(parseDevices('')).toEqual([])
    expect(parseDevices('List of devices attached\n\n')).toEqual([])
  })
})

describe('parseSockets', () => {
  const sample = [
    'Num       RefCount Protocol Flags    Type St Inode Path',
    '0000000000000000: 00000002 00000000 00010000 0001 01 40238 @webview_devtools_remote_12345',
    '0000000000000000: 00000002 00000000 00010000 0001 01 40239 @webview_devtools_remote_6789',
    '0000000000000000: 00000002 00000000 00010000 0001 01 40240 @chrome_devtools_remote',
    '0000000000000000: 00000002 00000000 00010000 0001 01 40241 @webview_devtools_tethering_12345_1',
    '0000000000000000: 00000002 00000000 00010000 0001 01 40242 @webview_devtools_remote_12345',
    '0000000000000000: 00000002 00000000 00010000 0001 01 40243 @something_else',
    '0000000000000000: 00000002 00000000 00010000 0001 01 40244'
  ].join('\n')

  it('只留 devtools_remote,排除 tethering,并按名字去重', () => {
    const sockets = parseSockets(sample)
    expect(sockets.map((s) => s.name)).toEqual([
      'chrome_devtools_remote',
      'webview_devtools_remote_6789',
      'webview_devtools_remote_12345'
    ])
  })

  it('WebView 套接字带 pid(用于把「哪个 App」说清楚)', () => {
    const webview = parseSockets(sample).find((s) => s.name.endsWith('12345'))
    expect(webview).toEqual({ name: 'webview_devtools_remote_12345', kind: 'webview', pid: 12345 })
  })

  it('表头 / 无路径行 / 无关套接字都不会误报', () => {
    expect(parseSockets('')).toEqual([])
    expect(parseSockets('Num RefCount Protocol Flags Type St Inode Path')).toEqual([])
    expect(parseSockets('00000000: 00000002 00000000 00010000 0001 01 40243')).toEqual([])
  })

  it('带 pid 的 chrome_devtools_remote 也识别', () => {
    const [socket] = parseSockets('0000: 00 00 00010000 0001 01 1 @chrome_devtools_remote_4242')
    expect(socket).toEqual({ name: 'chrome_devtools_remote_4242', kind: 'chrome' })
  })

  it('normalizeSocketName 兼容带与不带 @ 两种写法', () => {
    expect(normalizeSocketName('@chrome_devtools_remote')).toBe('chrome_devtools_remote')
    expect(normalizeSocketName(' chrome_devtools_remote ')).toBe('chrome_devtools_remote')
  })
})

describe('parseForwardList', () => {
  it('解析串号 / 本地端口 / 远端套接字', () => {
    const out = parseForwardList(
      [
        'R58M12ABCDE tcp:9301 localabstract:webview_devtools_remote_12345',
        'R58M12ABCDE tcp:9302 localabstract:chrome_devtools_remote',
        'not-a-forward-line',
        'R58M12ABCDE tcp:9303 localabstract:webview_devtools_tethering_1_1'
      ].join('\n')
    )
    expect(out).toEqual([
      { serial: 'R58M12ABCDE', localPort: 9301, socket: 'webview_devtools_remote_12345' },
      { serial: 'R58M12ABCDE', localPort: 9302, socket: 'chrome_devtools_remote' },
      { serial: 'R58M12ABCDE', localPort: 9303, socket: 'webview_devtools_tethering_1_1' }
    ])
  })

  it('非 tcp: 的本地端(如 localfilesystem:)被跳过', () => {
    expect(parseForwardList('S1 localfilesystem:/tmp/x localabstract:y')).toEqual([])
  })
})

// ---------------------------------------------------------------- /json 改写

describe('ws 地址改写', () => {
  it('设备侧 localhost:9222 换成 bow 的转发端口', () => {
    expect(rewriteWsUrl('ws://localhost:9222/devtools/page/ABC', 'ABC', 9301)).toBe(
      'ws://127.0.0.1:9301/devtools/page/ABC'
    )
  })

  it('browser 目标(路径是 /devtools/browser/<guid>)保留原路径', () => {
    expect(
      rewriteWsUrl('ws://localhost:9222/devtools/browser/9f0e-1234', 'other', 9301)
    ).toBe('ws://127.0.0.1:9301/devtools/browser/9f0e-1234')
  })

  it('地址缺失/不合法时按 id 兜底成 /devtools/page/<id>', () => {
    expect(wsPathOf('', 'XYZ')).toBe('/devtools/page/XYZ')
    expect(wsPathOf('not a url', 'XYZ')).toBe('/devtools/page/XYZ')
    expect(wsPathOf('ws://localhost:9222/json/list', 'XYZ')).toBe('/devtools/page/XYZ')
    expect(rewriteWsUrl('', 'XYZ', 9301)).toBe('ws://127.0.0.1:9301/devtools/page/XYZ')
  })

  it('ws= 查询参数不带 scheme(带 scheme 会白屏)', () => {
    expect(wsParamOf('ws://127.0.0.1:9301/devtools/page/ABC')).toBe(
      '127.0.0.1:9301/devtools/page/ABC'
    )
    expect(wsParamOf('wss://example.com/devtools/page/ABC')).toBe('example.com/devtools/page/ABC')
  })

  it('前端入口常量与识别函数只在 @shared/devtools 里定义一份', () => {
    expect(devtoolsFrontendUrl('ws://127.0.0.1:9301/devtools/page/ABC')).toBe(
      'devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:9301/devtools/page/ABC'
    )
    expect(isDevToolsFrontendUrl('devtools://devtools/bundled/devtools_app.html')).toBe(true)
    expect(isDevToolsFrontendUrl('https://example.com')).toBe(false)
  })

  it('electron-bundled:用 bow 自带前端', () => {
    expect(frontendUrlFor('electron-bundled', { wsUrl: 'ws://127.0.0.1:9301/devtools/page/ABC', localPort: 9301 })).toBe(
      'devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:9301/devtools/page/ABC'
    )
  })

  it('device-suggested:用设备给的那份前端(ws 换成中继端口)', () => {
    const ws = 'ws://127.0.0.1:9301/devtools/page/ABC'
    const suggested = suggestedFrontendUrl(
      'https://chrome-devtools-frontend.appspot.com/serve_rev/@2d64ccbb0716a9c780633f2f193d3cef31637892/inspector.html?ws=127.0.0.1:9222/devtools/page/ABC',
      { wsUrl: ws, localPort: 9301 }
    )
    expect(suggested).toBe(
      'https://chrome-devtools-frontend.appspot.com/serve_rev/@2d64ccbb0716a9c780633f2f193d3cef31637892/inspector.html?ws=127.0.0.1:9301/devtools/page/ABC'
    )
    expect(frontendUrlFor('device-suggested', { wsUrl: ws, localPort: 9301, suggested })).toBe(suggested)
  })

  it('device-suggested:设备自带前端(相对地址)也能认', () => {
    expect(
      suggestedFrontendUrl('/devtools/inspector.html?ws=localhost:9222/devtools/page/ABC', {
        wsUrl: 'ws://127.0.0.1:9301/devtools/page/ABC',
        localPort: 9301
      })
    ).toBe('http://127.0.0.1:9301/devtools/inspector.html?ws=127.0.0.1:9301/devtools/page/ABC')
  })

  it('设备没给地址(或给的是垃圾)→ null,由调用方回退 bow 自带', () => {
    const ws = 'ws://127.0.0.1:9301/devtools/page/ABC'
    expect(suggestedFrontendUrl(undefined, { wsUrl: ws, localPort: 9301 })).toBeNull()
    expect(suggestedFrontendUrl('', { wsUrl: ws, localPort: 9301 })).toBeNull()
    expect(suggestedFrontendUrl('chrome-devtools://devtools/bundled/inspector.html', { wsUrl: ws, localPort: 9301 })).toBeNull()
    expect(frontendUrlFor('device-suggested', { wsUrl: ws, localPort: 9301, suggested: null })).toBe(
      'devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:9301/devtools/page/ABC'
    )
  })

  it('firstSuggestedFrontendUrl:从 /json 里挑第一条可用的设备前端', () => {
    const raw = [
      { id: 'A', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/A' },
      {
        id: 'B',
        webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/B',
        devtoolsFrontendUrl: 'https://chrome-devtools-frontend.appspot.com/serve_rev/@abc/inspector.html?ws=localhost:9222/devtools/page/B'
      }
    ]
    expect(firstSuggestedFrontendUrl(raw, { localPort: 9301 })).toBe(
      'https://chrome-devtools-frontend.appspot.com/serve_rev/@abc/inspector.html?ws=127.0.0.1:9301/devtools/page/B'
    )
    expect(firstSuggestedFrontendUrl(null, { localPort: 9301 })).toBeNull()
  })
})

describe('targetsFromJson', () => {
  const ctx = {
    serial: 'R58M1',
    socket: 'webview_devtools_remote_7',
    localPort: 9301,
    package: 'com.example.app',
    strategy: 'electron-bundled' as const
  }
  const payload = [
    {
      description: '',
      devtoolsFrontendUrl: '/devtools/inspector.html?ws=localhost:9222/devtools/page/W1',
      id: 'W1',
      title: '我的页面',
      type: 'webview',
      url: 'https://example.com/a',
      webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/W1'
    },
    {
      id: 'P2',
      title: '首页',
      type: 'page',
      url: 'https://example.com/',
      webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/P2'
    },
    { id: 'S3', title: '', type: 'service_worker', url: 'https://example.com/sw.js' },
    { title: '没有 id 的条目', type: 'page' },
    'not-an-object'
  ]

  it('逐条改写成我们自己的模型(含 targetKey 与前端地址)', () => {
    const target = targetsFromJson(payload, ctx).find((t) => t.id === 'P2')!
    expect(target).toMatchObject({
      id: 'P2',
      key: 'R58M1|webview_devtools_remote_7|P2',
      serial: 'R58M1',
      socket: 'webview_devtools_remote_7',
      type: 'page',
      title: '首页',
      wsUrl: 'ws://127.0.0.1:9301/devtools/page/P2',
      frontendUrl: 'devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:9301/devtools/page/P2',
      package: 'com.example.app'
    })
  })

  it('page/webview/iframe 都排在 worker 之前(同组内顺序不做承诺)', () => {
    const types = targetsFromJson(payload, ctx).map((t) => t.type)
    const workerAt = types.indexOf('service_worker')
    expect(types.slice(0, workerAt).every((t) => t === 'page' || t === 'webview' || t === 'iframe')).toBe(true)
    expect(workerAt).toBe(types.length - 1)
  })

  it('缺 id 或不是对象/数组的条目被跳过而不是抛错', () => {
    expect(targetsFromJson(payload, ctx)).toHaveLength(3)
    expect(targetsFromJson(null, ctx)).toEqual([])
    expect(targetsFromJson({ error: 'nope' }, ctx)).toEqual([])
    expect(targetsFromJson('[]', ctx)).toEqual([])
  })

  it('缺 ws 地址的条目仍可展示,只是 ws 地址按 id 兜底', () => {
    const [worker] = targetsFromJson(payload, ctx).filter((t) => t.type === 'service_worker')
    expect(worker.wsUrl).toBe('ws://127.0.0.1:9301/devtools/page/S3')
  })

  it('没有包名时不编造', () => {
    const [first] = targetsFromJson(payload, { ...ctx, package: undefined })
    expect(first.package).toBeUndefined()
  })
})

describe('前端来源:版本判定', () => {
  it('从 /json/version 的 Browser 串里取出主版本号', () => {
    expect(parseBrowserMajor('Chrome/138.0.7204.179')).toBe(138)
    expect(parseBrowserMajor('WebView/120.0.6099.230')).toBe(120)
    expect(parseBrowserMajor('152')).toBe(152)
    expect(parseBrowserMajor(undefined)).toBeUndefined()
    expect(parseBrowserMajor('')).toBeUndefined()
    expect(parseBrowserMajor('Chrome/unknown')).toBeUndefined()
  })

  it('Chromium 146 以下的设备必须用设备自带前端(否则取不到 storage key)', () => {
    // 阈值本身的依据在 shared.ts 的注释里:140 无 Storage.getStorageKey、146 有
    expect(FRONTEND_STORAGE_KEY_MIN_MAJOR).toBe(146)
    expect(needsDeviceFrontend('Chrome/138.0.7204.179')).toBe(true)
    expect(needsDeviceFrontend('Chrome/120.0.6099.43')).toBe(true)
    expect(needsDeviceFrontend('Chrome/145.0.0.0')).toBe(true)
    expect(needsDeviceFrontend('Chrome/146.0.7680.31')).toBe(false)
    expect(needsDeviceFrontend('Chrome/152.0.7977.78')).toBe(false)
    // 版本解析不出来时按「不需要」处理:不依赖设备提供前端资源
    expect(needsDeviceFrontend(undefined)).toBe(false)
    expect(needsDeviceFrontend('WebView/unknown')).toBe(false)
  })

  it('auto 按设备挑前端;显式指定时永远听用户的', () => {
    expect(effectiveStrategy('auto', { browser: 'Chrome/138.0.7204.179' })).toBe('device-suggested')
    expect(effectiveStrategy('auto', { browser: 'Chrome/152.0.7977.78' })).toBe('electron-bundled')
    expect(effectiveStrategy('electron-bundled', { browser: 'Chrome/138.0.7204.179' })).toBe(
      'electron-bundled'
    )
    expect(effectiveStrategy('device-suggested', { browser: 'Chrome/152.0.7977.78' })).toBe('device-suggested')
  })

  it('设备给的前端打不开时,auto 回退到 bow 自带(至少 Elements/Console 可用)', () => {
    expect(
      effectiveStrategy('auto', { browser: 'Chrome/138.0.7204.179', suggestedAvailable: false })
    ).toBe('electron-bundled')
    expect(
      effectiveStrategy('auto', { browser: 'Chrome/138.0.7204.179', suggestedAvailable: true })
    ).toBe('device-suggested')
  })

  it('持久化/设置里的脏值一律回落 auto,旧名字 device-bundled 归一到 device-suggested', () => {
    expect(normalizeStrategy('auto')).toBe('auto')
    expect(normalizeStrategy('device-suggested')).toBe('device-suggested')
    expect(normalizeStrategy('device-bundled')).toBe('device-suggested')
    expect(normalizeStrategy('electron-bundled')).toBe('electron-bundled')
    expect(normalizeStrategy('nope')).toBe('auto')
    expect(normalizeStrategy(undefined)).toBe('auto')
    expect(normalizeStrategy(42)).toBe('auto')
  })

  it('只有真正走 WSL 的 adb 命令才算 WSL(否则「端口连不上」会误指镜像网络)', () => {
    expect(isWslAdb('wsl adb')).toBe(true)
    expect(isWslAdb('wsl.exe -d Ubuntu-24.04 adb')).toBe(true)
    expect(isWslAdb('adb')).toBe(false)
    expect(isWslAdb('C:\\platform-tools\\adb.exe')).toBe(false)
    expect(isWslAdb('')).toBe(false)
  })

  it('面板解释文案的判定:只在「确实值得一提」时给非空结果', () => {
    const old = 'Chrome/138.0.7204.179'
    const modern = 'Chrome/152.0.7977.78'
    // 自动模式真的换了前端 → 解释为什么
    expect(frontendNotice('auto', { browser: old, effective: 'device-suggested' })).toBe(
      'auto-switched-to-device'
    )
    // 想换但设备给的前端打不开 → 解释回退
    expect(frontendNotice('auto', { browser: old, effective: 'electron-bundled' })).toBe(
      'auto-fallback-to-electron'
    )
    // 用户强制设备指定但打不开 → 解释回退(不是静默无视)
    expect(frontendNotice('device-suggested', { browser: old, effective: 'electron-bundled' })).toBe(
      'forced-device-unavailable'
    )
    // 用户强制 bow 自带、设备又是老版本 → 提醒存储面板会空(用户的显式选择仍然尊重)
    expect(frontendNotice('electron-bundled', { browser: old, effective: 'electron-bundled' })).toBe(
      'electron-incompatible'
    )
    // 版本对得上 / 按用户选择换了设备前端 → 没什么可说的
    expect(frontendNotice('auto', { browser: modern, effective: 'electron-bundled' })).toBeNull()
    expect(frontendNotice('device-suggested', { browser: old, effective: 'device-suggested' })).toBeNull()
    expect(frontendNotice('electron-bundled', { browser: modern, effective: 'electron-bundled' })).toBeNull()
  })
})

describe('sortTargets', () => {
  const target = (id: string, type: string, title: string): DeviceTarget => ({
    key: `s|k|${id}`,
    id,
    serial: 's',
    socket: 'k',
    type,
    title,
    url: '',
    wsUrl: '',
    frontendUrl: ''
  })

  it('交互型在前、同组内按标题排序(码点序,不依赖 locale)', () => {
    const out = sortTargets([target('1', 'worker', 'b'), target('2', 'page', 'z'), target('3', 'page', 'a')])
    expect(out.map((t) => t.id)).toEqual(['3', '2', '1'])
  })
})

describe('版本信息', () => {
  it('Browser 与 Android-Package 都取字符串,其它类型忽略', () => {
    expect(browserNameFromVersion({ Browser: 'Chrome/120.0.6099.43' })).toBe('Chrome/120.0.6099.43')
    expect(browserNameFromVersion({ Browser: 1 })).toBeUndefined()
    expect(browserNameFromVersion(null)).toBeUndefined()
    expect(androidPackageFromVersion({ 'Android-Package': 'com.tencent.mm' })).toBe('com.tencent.mm')
    expect(androidPackageFromVersion({})).toBeUndefined()
  })
})

// ---------------------------------------------------------------- 展示与提示

describe('展示标签', () => {
  it('套接字标签带上包名与类型', () => {
    expect(socketLabel({ name: 'webview_devtools_remote_7', kind: 'webview', pid: 7 }, 'com.a.b')).toBe(
      'com.a.b · WebView #7'
    )
    expect(socketLabel({ name: 'chrome_devtools_remote', kind: 'chrome' })).toBe('Chrome')
  })

  it('目标类型有中文标签,未知类型原样返回', () => {
    expect(targetTypeLabel('webview')).toBe('WebView')
    expect(targetTypeLabel('mystery')).toBe('mystery')
  })

  it('targetKey 可拆回三段', () => {
    const key = targetKey('R58M1', 'webview_devtools_remote_7', 'ABC-DEF')
    expect(key).toBe('R58M1|webview_devtools_remote_7|ABC-DEF')
    expect(splitTargetKey(key)).toEqual({
      serial: 'R58M1',
      socket: 'webview_devtools_remote_7',
      targetId: 'ABC-DEF'
    })
    expect(splitTargetKey('bad')).toBeNull()
  })
})

describe('problemHint', () => {
  const problems: DiscoverProblem[] = [
    'no-adb',
    'no-devices',
    'unauthorized',
    'offline',
    'no-sockets',
    'no-targets',
    'forward-failed',
    'port-unreachable'
  ]

  it('每种失败态都给出非空标题与可执行的下一步', () => {
    for (const problem of problems) {
      const hint = problemHint(problem, { serial: 'R58M1', detail: 'raw stderr' })
      expect(hint.title.length, problem).toBeGreaterThan(0)
      expect(hint.detail.length, problem).toBeGreaterThan(0)
    }
  })

  it('「没有可调试 WebView」把最关键的两条原因写清楚(release 包默认不开调试)', () => {
    const hint = problemHint('no-sockets')
    expect(hint.detail).toContain('setWebContentsDebuggingEnabled')
    expect(hint.detail).toContain('release')
  })

  it('转发端口连不上时,原生 adb 先指向「目标进程已退出」,并提示刷新', () => {
    const hint = problemHint('port-unreachable')
    expect(hint.detail).toContain('刷新')
    expect(hint.detail).not.toContain('Mirrored')
  })

  it('只有 adb 走 WSL 时才提 WSL2 镜像网络', () => {
    expect(problemHint('port-unreachable', { wsl: true }).detail).toContain('Mirrored')
  })
})
