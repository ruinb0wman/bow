/**
 * `READ_FN`(browser_read 的正文抽取)单测。
 *
 * 为什么用 jsdom 而不是像 fakeWc 那样手搓 DOM 桩:这里要验的是**启发式**(挑正文容器、链接密度惩罚、
 * markdown 序列化),手搓桩等于把那套启发式的输入喂成我想要的形状,测不出真东西。
 * 不在 vitest 配置里全局开 jsdom 环境,只在本文件里按需建 —— 其余 1300+ 用例仍是纯 node 环境。
 */

import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { READ_FN } from '../src/main/pageScripts'

const BASE = 'https://example.com/page'

interface ReadResult {
  error?: string
  title?: string
  url?: string
  mode?: string
  markdown?: string
  chars?: number
  truncated?: boolean
}

/** 把注入脚本跑在给定 HTML 上(与浏览器里 `(function __mcpRead__(...))(opts)` 同形) */
function read(html: string, opts: Record<string, unknown> = {}): ReadResult {
  const dom = new JSDOM(html, { url: BASE })
  const run = new Function(
    'document',
    'location',
    'URL',
    'opts',
    'return (' + READ_FN + ')(opts)'
  ) as (...a: unknown[]) => ReadResult
  return run(dom.window.document, dom.window.location, dom.window.URL, opts)
}

describe('READ_FN 注入脚本自身', () => {
  it('是函数声明且名字与文件约定一致(cdp 侧要按这个名字拼调用)', () => {
    expect(READ_FN.startsWith('function __mcpRead__(opts){')).toBe(true)
    expect(() => new Function('return (' + READ_FN + ')')).not.toThrow()
  })

  it('默认上限 12000 字符(不传 maxChars 时)', () => {
    const para = '<p>' + '这一段正文内容会被重复很多次,用来把输出撑过默认的 12000 字符上限。'.repeat(2) + '</p>'
    const res = read(`<article>${para.repeat(200)}</article>`)
    expect(res.truncated).toBe(true)
    expect(res.markdown).toContain('已截断')
  })
})

describe('正文抽取:挑容器', () => {
  const page = `<!doctype html><html><head><title>文章标题 - 站点</title></head><body>
    <header><h1>站点名</h1><nav><a href="/a">首页</a><a href="/b">关于</a></nav></header>
    <div class="sidebar"><p>侧栏推广文案,这里有很多字但是属于噪声。这里有很多字但是属于噪声。</p></div>
    <main><article>
      <h1>文章标题</h1>
      <p>第一段正文。这里是一些足够长的句子,用来让打分器认为它是正文段落,还要再加一点字数。</p>
      <h2>小节标题</h2>
      <p>第二段正文。<b>重点内容</b>也要保留,参考<a href="/ref">这个链接</a>。</p>
    </article></main>
    <aside><p>相关推荐:这里有足够长的文字但它是噪声内容,不应该出现在抽取结果里。</p></aside>
    <footer><p>版权所有 2026 示例公司,这一段也不该出现,它的字数同样足够长哦。</p></footer>
    <script>window.__secret = '脚本内容不该出现'</script>
    <style>.x{color:red}</style>
  </body></html>`

  it('选中正文容器,而不是最外层 wrapper(导航/侧栏/页脚都不进来)', () => {
    const res = read(page)
    expect(res.mode).toBe('main')
    expect(res.title).toBe('文章标题 - 站点')
    expect(res.markdown).toContain('第一段正文')
    expect(res.markdown).toContain('第二段正文')
    // 站点头部在 body 层级:若挑错容器(退到 body)它就会冒出来
    expect(res.markdown).not.toContain('站点名')
    expect(res.markdown).not.toContain('侧栏推广文案')
    expect(res.markdown).not.toContain('相关推荐')
    expect(res.markdown).not.toContain('版权所有')
    expect(res.markdown).not.toContain('脚本内容不该出现')
  })

  it('标题按级别转 markdown,行内强调与链接跟着转', () => {
    const res = read(page)
    expect(res.markdown).toContain('# 文章标题')
    expect(res.markdown).toContain('## 小节标题')
    expect(res.markdown).toContain('**重点内容**')
    expect(res.markdown).toContain('[这个链接](https://example.com/ref)')
  })

  it('模板里没有任何段落标签时退到整个 body,并且仍然拿得到文本', () => {
    const res = read(`<body><div id="wrap">
      <div>这是唯一的内容,全部放在 div 里,没有任何段落标签也没有标题标签。</div>
      <div>第二行内容,同样在 div 里,用来验证退路确实拿到了整段文本。</div>
    </div></body>`)
    expect(res.mode).toBe('wide')
    expect(res.markdown).toContain('这是唯一的内容')
    expect(res.markdown).toContain('第二行内容')
  })

  it('正文太短而页面上还有大段文字时放宽到整页(不返回空 markdown)', () => {    const res = read(`<body>
      <article><p>一小段文字,长度刚过二十个字符的阈值,足以让它被选中。</p></article>
      <div id="more">这里有一大堆没有任何段落标签的文字,直接放在 div 里。它足够长,长到正文容器抽出来的东西远远不足以代表整页内容,因此应该触发降级,把整页文本都交出来。</div>
    </body>`)
    expect(res.mode).toBe('wide')
    expect(res.markdown).toContain('一小段文字')
    expect(res.markdown).toContain('没有任何段落标签的文字')
  })
})

describe('正文抽取:序列化', () => {
  it('无序/有序列表转成 markdown,嵌套缩进保留', () => {
    const res = read(`<article>
      <p>下面是一份清单,前面这段文字要够长才会被当作正文段落来处理。</p>
      <ul>
        <li>第一项</li>
        <li>第二项
          <ul><li>嵌套项 A</li><li>嵌套项 B</li></ul>
        </li>
      </ul>
      <ol><li>步骤一</li><li>步骤二</li></ol>
    </article>`)
    expect(res.markdown).toContain('- 第一项')
    expect(res.markdown).toContain('- 第二项')
    expect(res.markdown).toContain('  - 嵌套项 A')
    expect(res.markdown).toContain('1. 步骤一')
    expect(res.markdown).toContain('2. 步骤二')
  })

  it('表格转 markdown 表格,表头与分隔行都在', () => {
    const res = read(`<article>
      <h2>数据</h2>
      <table>
        <caption>季度营收</caption>
        <thead><tr><th>季度</th><th>金额</th></tr></thead>
        <tbody><tr><td>Q1</td><td>100</td></tr><tr><td>Q2</td><td>200</td></tr></tbody>
      </table>
      <p>表格之后的正文,需要足够长才能被认作正文段落,再加一些字数凑一凑让它通过阈值。</p>
    </article>`)
    expect(res.markdown).toContain('**季度营收**')
    expect(res.markdown).toContain('| 季度 | 金额 |')
    expect(res.markdown).toContain('| --- | --- |')
    expect(res.markdown).toContain('| Q1 | 100 |')
    expect(res.markdown).toContain('| Q2 | 200 |')
  })

  it('单元格里的竖线被转义(否则把表格结构撑破)', () => {
    const res = read(`<article>
      <p>前面这段文字要够长,否则表格所在的容器不会被选中为正文。</p>
      <table><tr><th>表达式</th><th>含义</th></tr><tr><td>a | b</td><td>或</td></tr></table>
    </article>`)
    expect(res.markdown).toContain('a \\| b')
  })

  it('data URI 图片只留 alt,base64 绝不进上下文;无 alt 的图片整个丢掉', () => {
    const res = read(`<article>
      <p>正文段落,要足够长才能被当作正文段落识别出来,再加一点字数凑够阈值才行。</p>
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" alt="内联图">
      <img src="/photo.jpg" alt="照片">
      <img src="/noalt.jpg">
      <p>段落二,同样需要足够长的文字来通过打分阈值,再来一些内容填充一下字数。</p>
    </article>`)
    expect(res.markdown).not.toContain('iVBORw0KGgo')
    expect(res.markdown).toContain('[图片: 内联图]')
    expect(res.markdown).toContain('![图片: 照片](https://example.com/photo.jpg)')
    expect(res.markdown).not.toContain('noalt.jpg')
  })

  it('锚点与 javascript: 链接不成 markdown 链接,只留文字', () => {
    const res = read(`<article><p>一段足够长的正文,里面混着<a href="#">锚点</a>和<a href="javascript:void(0)">脚本链接</a>,用来验证无效链接被降级成纯文本。</p></article>`)
    expect(res.markdown).toContain('锚点')
    expect(res.markdown).toContain('脚本链接')
    expect(res.markdown).not.toContain('](https://example.com/page#)')
    expect(res.markdown).not.toContain('javascript:')
  })

  it('代码块保留换行,不被压成一行', () => {
    const res = read(`<article>
      <p>前面这段文字要够长,否则代码块所在的容器不会被选中为正文内容。</p>
      <pre>line1
line2</pre>
    </article>`)
    expect(res.markdown).toContain('```\nline1\nline2\n```')
  })
})

describe('selector 收窄与错误', () => {
  it('给 selector 时只读那棵子树,且不做噪声剪枝(显式请求就是明确要)', () => {
    const res = read(`<body>
      <div class="sidebar"><p>侧栏里的一段说明文字,内容够长。</p></div>
      <form id="f"><label>昵称</label><input name="nick"><button>提交</button><p>表单说明文字,这里写一些足够长的内容。</p></form>
    </body>`, { selector: '#f' })
    expect(res.mode).toBe('selector')
    expect(res.markdown).toContain('表单说明文字')
    expect(res.markdown).not.toContain('侧栏里的一段说明')
  })

  it('selector 找不到时明确报错,不返回空 markdown', () => {
    const res = read('<body><p>内容</p></body>', { selector: '#nope' })
    expect(res.error).toBe('未找到选择器: #nope')
    expect(res.markdown).toBeUndefined()
  })

  it('script/style 在任何模式下都不进输出', () => {
    const res = read('<body><div id="x"><style>.a{}</style><script>var s=1</script><p>可见正文内容,长度足够通过阈值。</p></div></body>', { selector: '#x' })
    expect(res.markdown).toContain('可见正文内容')
    expect(res.markdown).not.toContain('var s=1')
    expect(res.markdown).not.toContain('.a{}')
  })
})

describe('整页放宽:链接农场的剪枝', () => {
  const farm = `<div class="navfarm">${Array.from({ length: 6 }, (_, i) => `<a href="/l${i}">导航链接第 ${i} 项</a>`).join('')}</div>`

  it('整页只有一堆链接时:不把导航当正文倒出来,而是给出方向明确的失败', () => {
    const res = read(`<body>${farm}</body>`)
    expect(res.markdown).toBeUndefined()
    expect(res.error).toContain('链接列表/首页')
    expect(res.error).toContain('browser_snapshot')
  })

  it('链接农场旁边有真正文时:只丢农场,正文照常拿到', () => {
    const res = read(`<body>${farm}
      <div id="real">这是页面真正的正文,它被放在一个没有任何段落标签的 div 里,长度足够被当作文本来读。</div>
    </body>`)
    expect(res.mode).toBe('wide')
    expect(res.markdown).toContain('页面真正的正文')
    expect(res.markdown).not.toContain('导航链接第')
  })

  it('正文容器内的链接列表不受影响(参考资料这类是有效信息)', () => {
    const res = read(`<article>
      <p>前面这段正文要够长,才能让这个容器被选为正文,否则就跑去整页了。</p>
      <ul><li><a href="/r1">参考资料一</a></li><li><a href="/r2">参考资料二</a></li></ul>
    </article>`)
    expect(res.mode).toBe('main')
    expect(res.markdown).toContain('参考资料一')
  })
})

describe('截断', () => {
  it('maxChars 生效,停在段落边界并给出可操作的提示', () => {
    const paras = Array.from({ length: 30 }, (_, i) => `<p>第 ${i} 段。${'这一段需要足够长才能触发截断逻辑。'.repeat(4)}</p>`).join('')
    const res = read(`<article>${paras}</article>`, { maxChars: 400 })
    expect(res.truncated).toBe(true)
    expect(res.chars).toBeLessThanOrEqual(400 + 120)
    expect(res.markdown).toContain('已截断')
    expect(res.markdown).toContain('selector')
    // 没有把某一段砍成半截
    expect(res.markdown.trimEnd().endsWith(')')).toBe(true)
  })

  it('不超上限时不标记截断', () => {
    const res = read('<article><p>很短的一篇正文,足够通过阈值但远不到上限。</p></article>', { maxChars: 1000 })
    expect(res.truncated).toBe(false)
    expect(res.markdown).not.toContain('已截断')
  })
})
