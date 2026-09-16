/**
 * 产物自检的「运行时外部依赖」扫描:正则会直接决定 `npm run dist` 的成败,
 * 过宽就会把 bundle 里的普通字符串当成依赖,让打包在自检这一步误报失败。
 *
 * 回归来源(真实发生过):广告规则选项表是一串字符串字面量,里面有 `"from",` —— 它后跟下一行的
 * `"ipaddress",`,于是 `from\s*["']` 匹配上,扫出依赖名 `",\n  "`,自检报
 * 「asar 里缺少运行时依赖 node_modules/」,整个打包失败。
 */

import { describe, expect, it } from 'vitest'
import { externalRequires } from '../scripts/lib/externalRequires.mjs'

describe('产物自检:运行时外部依赖扫描', () => {
  it('字符串列表里的 "from" 不会被当成模块引用', () => {
    const bundle = [
      'const UNSUPPORTED_OPTIONS = new Set([',
      '  "document",',
      '  "removeparam",',
      '  "from",',
      '  "ipaddress",',
      '  "strict3p"',
      ']);',
      'const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");',
      'const zod = require("zod");'
    ].join('\n')

    expect(externalRequires(bundle)).toEqual(['@modelcontextprotocol/sdk', 'zod'])
  })

  it('require 与 import ... from 都识别,子路径只取包名', () => {
    const bundle = `
      import { z } from "zod/v3";
      import sdk from "@modelcontextprotocol/sdk/client/index.js";
      const vue = require("vue");
      const lodash = require("lodash/merge");
    `
    expect(externalRequires(bundle)).toEqual(['@modelcontextprotocol/sdk', 'lodash', 'vue', 'zod'])
  })

  it('跳过相对路径、绝对路径、node: 内置与 electron', () => {
    const bundle = `
      import a from "./local.js";
      import b from "/abs/thing.js";
      import c from "node:fs";
      import d from "node:fs/promises";
      import e from "electron";
      import f from "electron/main";
      import g from "zod";
    `
    expect(externalRequires(bundle)).toEqual(['zod'])
  })

  it('标识符尾段与对象属性里的 from 不算引用', () => {
    // 注:扫描是纯文本的,不认字符串上下文 —— bundle 里真的出现 `from "pkg"` 这种
    // 普通字符串仍会被算进来(判断不了)。这里只钉住已知不能误报的两种写法。
    const bundle = `
      const s = "requires an update from'x'";
      const transform = { from: "pkg" };
      const fxfromOK = 1;
    `
    expect(externalRequires(bundle)).toEqual([])
  })
})
