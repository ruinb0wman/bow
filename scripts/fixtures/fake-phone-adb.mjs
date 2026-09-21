/**
 * 假「手机 + adb 服务端」:给 bow 的设备检查插件喂一套可预测的 adb 输出与 CDP 端点。
 *
 * 由 `scripts/e2e-device-inspect.mjs` 以 `adbCommand: 'node <本文件>'` 注入插件(复合命令支持见
 * `shared.parseAdbSetting`)。`forward` 子命令会拉起一个**独立的假设备进程**
 * (`fake-phone-device.mjs`),因为每条 adb 命令都是冷启动 —— 设备端点必须活得比这条命令久;
 * 进程号记在 `$BOW_E2E_DIR/forwards.json` 里,`forward --remove` 与 E2E 收尾都据此收掉它。
 *
 * 只实现插件真正用到的子命令:version / devices -l / -s <serial> shell cat /proc/net/unix /
 * forward tcp:P localabstract:X / forward --remove tcp:P / forward --list。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = process.env.BOW_E2E_DIR ?? join(tmpdir(), 'bow-e2e')
const DEVICE_SCRIPT = fileURLToPath(new URL('./fake-phone-device.mjs', import.meta.url))
const FORWARDS = `${DIR}/forwards.json`
const ADB_LOG = `${DIR}/adb-log.jsonl`
const SERIAL = 'FAKE123'
const SOCKET = 'webview_devtools_remote_4242'

const args = process.argv.slice(2)
appendFileSync(ADB_LOG, JSON.stringify({ t: Date.now(), args }) + '\n')

function out(text) {
  process.stdout.write(text + '\n')
}
function readForwards() {
  try {
    return JSON.parse(readFileSync(FORWARDS, 'utf8'))
  } catch {
    return []
  }
}
function writeForwards(records) {
  writeFileSync(FORWARDS, JSON.stringify(records, null, 2))
}
function waitPort(port, timeoutMs = 5000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - started > timeoutMs) reject(new Error(`假设备端口 ${port} 没起来`))
        else setTimeout(attempt, 50)
      })
    }
    attempt()
  })
}

if (args[0] === 'version') {
  out('Android Debug Bridge version 1.0.41')
  out('Version 35.0.2-13114758')
  process.exit(0)
}

if (args[0] === 'devices') {
  out('List of devices attached')
  out(`${SERIAL}\tdevice product:panther model:Pixel_7 device:panther transport_id:1`)
  process.exit(0)
}

if (args.includes('shell')) {
  out('Num       RefCount Protocol Flags    Type St Inode Path')
  out(`0000000000000000: 00000002 00000000 00010000 0001 01 4242 @${SOCKET}`)
  process.exit(0)
}

const forwardIdx = args.indexOf('forward')
if (forwardIdx >= 0) {
  const rest = args.slice(forwardIdx + 1)

  if (rest[0] === '--list') {
    for (const record of readForwards()) out(`${SERIAL} tcp:${record.port} localabstract:${record.socket}`)
    process.exit(0)
  }

  if (rest[0] === '--remove') {
    const port = Number(String(rest[1] ?? '').replace('tcp:', ''))
    const records = readForwards()
    const hit = records.find((r) => r.port === port)
    if (hit?.pid) {
      try {
        process.kill(hit.pid)
      } catch {
        /* 已经没了 */
      }
    }
    writeForwards(records.filter((r) => r.port !== port))
    process.exit(0)
  }

  // adb forward tcp:<port> localabstract:<socket>
  const port = Number(String(rest[0] ?? '').replace('tcp:', ''))
  const socket = String(rest[1] ?? '').replace('localabstract:', '')
  if (!port || !socket) {
    process.stderr.write('fake-adb: forward 参数不对\n')
    process.exit(1)
  }
  const child = spawn(process.execPath, [DEVICE_SCRIPT, String(port)], {
    detached: true,
    stdio: 'ignore',
    env: process.env
  })
  child.unref()
  try {
    await waitPort(port)
  } catch (error) {
    process.stderr.write(`fake-adb: ${String(error)}\n`)
    process.exit(1)
  }
  writeForwards([...readForwards().filter((r) => r.port !== port), { port, socket, pid: child.pid }])
  out(`tcp:${port}`)
  process.exit(0)
}

process.exit(0)
