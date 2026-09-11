#!/usr/bin/env node
/**
 * 北向资金(沪深股通)月/季度数据抓取器
 *
 * 背景:2024-08-19 起交易所停止披露北向资金"净买入/买卖盘",公共接口(腾讯/新浪/同花顺)
 *       已下线,东方财富旧 kline 接口只回占位零值。仍持续披露、可机器读取的是:
 *         - 北向每日"成交总额"(沪股通 001 / 深股通 003 / 合计 005):RPT_MUTUAL_DEAL_HISTORY
 *         - 北向每日"十大成交活跃股"(仅成交额):RPT_MUTUAL_TOP10DEAL
 *         - 南向港股通(002/004/006)至今仍披露完整买卖盘与净买入
 *   本脚本把日度成交总额聚合为"月/季度"数据,每行自带统计周期时间标注。
 *
 * 用法:
 *   node scripts/fetch-northbound.mjs                # 最近 18 个月,月+季度
 *   node scripts/fetch-northbound.mjs --since 2025-01-01
 *   node scripts/fetch-northbound.mjs --json > out.json
 *
 * 输出字段说明(时间标注):
 *   period       统计周期,如 "2026-08" / "2026Q3"
 *   period_start 该周期内首个交易日
 *   period_end   该周期内末个交易日
 *   asof         数据披露的最后交易日(数据实际截止时间)
 *   generated_at 脚本生成时刻
 *   其余为各口径成交额(单位:亿元),成交额=买入+卖出,北向无买卖拆分
 */

const API = 'https://datacenter-web.eastmoney.com/api/data/v1/get'

const TYPES = {
  '001': 'SH_HUGT_NORTH(沪股通)',
  '003': 'SZ_HUGT_NORTH(深股通)',
  '005': 'NORTH_TOTAL(北向合计)',
  '002': 'HKEX_SH_SOUTH(港股通-沪)',
  '004': 'HKEX_SZ_SOUTH(港股通-深)',
  '006': 'SOUTH_TOTAL(南向合计)',
}

const args = process.argv.slice(2)
const sinceIdx = args.indexOf('--since')
const SINCE = sinceIdx >= 0 ? args[sinceIdx + 1] : (() => {
  const d = new Date(Date.now() - 18 * 30 * 864e5)
  return d.toISOString().slice(0, 10)
})()
const asJson = args.includes('--json')

function lastNDaysBase() {
  // 传 base 参数避免 CDN 缓存
  return `&_=${Date.now()}`
}

async function fetchDealHistory() {
  const rows = []
  let page = 1
  for (;;) {
    const url =
      `${API}?reportName=RPT_MUTUAL_DEAL_HISTORY&columns=ALL&source=WEB&client=WEB` +
      `&pageNumber=${page}&pageSize=500&sortColumns=TRADE_DATE&sortTypes=-1` +
      `&filter=(TRADE_DATE%3E%3D%27${SINCE}%27)${lastNDaysBase()}`
    // datacenter-web 偶发 9701"服务器繁忙",重试 3 次并退避
    let j = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
      j = await r.json()
      if (j?.result?.data || !j?.message?.includes('繁忙')) break
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)))
    }
    const data = j?.result?.data
    if (!data || data.length === 0) {
      if (j?.message && !j?.message?.includes('繁忙')) {
        throw new Error(`接口返回异常: ${j.message} (page=${page})`)
      }
      break
    }
    rows.push(...data)
    if (j?.result?.pages == null || j.result.pages <= page) break
    page++
    await new Promise((res) => setTimeout(res, 300))
  }
  // 6 种 MUTUAL_TYPE 每天 6 行,去重保底
  const seen = new Set()
  return rows.filter((r) => {
    const k = `${r.MUTUAL_TYPE}|${String(r.TRADE_DATE).slice(0, 10)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** 万元?不——本接口单位经交叉验证为"百万元",此处统一换算成"亿元" */
const toYi = (v) => (v == null ? null : Math.round((v / 100) * 100) / 100)

function bucketKey(dateStr, granularity) {
  const [y, m] = dateStr.split('-').map(Number)
  if (granularity === 'month') return `${y}-${String(m).padStart(2, '0')}`
  return `${y}Q${Math.floor((m - 1) / 3) + 1}`
}

function bucketLabel(key, granularity) {
  if (granularity === 'month') return key
  const [y, q] = key.split('Q')
  return `${y}年Q${q}`
}

function aggregate(rows, granularity) {
  const buckets = new Map()
  for (const r of rows) {
    const date = String(r.TRADE_DATE).slice(0, 10)
    const key = bucketKey(date, granularity)
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        periodStart: date,
        periodEnd: date,
        dates: new Set(),
        vals: {}, // type -> {deal, buy, sell, net}
      })
    }
    const b = buckets.get(key)
    if (date < b.periodStart) b.periodStart = date
    if (date > b.periodEnd) b.periodEnd = date
    b.dates.add(date)
    const t = b.vals[r.MUTUAL_TYPE] || (b.vals[r.MUTUAL_TYPE] = { deal: 0, buy: null, sell: null, net: null })
    if (r.DEAL_AMT != null) t.deal += Number(r.DEAL_AMT)
    // 南向仍在披露买卖拆分的字段;北向为 null
    if (r.BUY_AMT != null) t.buy = (t.buy ?? 0) + Number(r.BUY_AMT)
    if (r.SELL_AMT != null) t.sell = (t.sell ?? 0) + Number(r.SELL_AMT)
    if (r.NET_DEAL_AMT != null) t.net = (t.net ?? 0) + Number(r.NET_DEAL_AMT)
  }
  const sorted = [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
  const asof = sorted.length
    ? sorted[sorted.length - 1].periodEnd
    : null
  return { sorted, asof }
}

function buildRecord(b, granularity, latestDate) {
  const v = b.vals
  const get = (t, f) => (v[t] ? toYi(v[t][f]) : null)
  const rec = {
    period: bucketLabel(b.key, granularity),
    period_start: b.periodStart,
    period_end: b.periodEnd,
    // 数据时间标注:该周期数据的截止交易日(当前未走完的周期即最新交易日,为部分数据)
    asof: b.periodEnd,
    is_partial: b.key === bucketKey(latestDate, granularity),
    trading_days: b.dates.size,
    // 北向:成交总额(亿元)——至今仍披露,为真实值
    north_sh_turnover: get('001', 'deal'),
    north_sz_turnover: get('003', 'deal'),
    north_total_turnover: get('005', 'deal'),
    // 北向:净买入——交易所自 2024-08-19 起停止披露,统一显式 null(不是 0!)
    // 语义:null=该字段根本不存在官方数据;0=仅南向可能出现真实零值。
    north_sh_netbuy: null,
    north_sz_netbuy: null,
    north_total_netbuy: null,
    // 南向:成交总额 + 净买入(亿元)——至今仍披露
    south_total_turnover: get('006', 'deal'),
    south_total_netbuy: get('006', 'net'),
    south_sh_netbuy: get('002', 'net'),
    south_sz_netbuy: get('004', 'net'),
  }
  return rec
}

async function main() {
  const rows = await fetchDealHistory()
  if (rows.length === 0) throw new Error(`无数据(since=${SINCE})`)
  const out = {
    generated_at: new Date().toISOString(),
    since: SINCE,
    unit: '亿元',
    note: '北向(沪深股通)自2024-08-19起不再披露净买入/买卖盘,此处仅有成交总额;南向(港股通)仍披露净买入。',
    null_semantics: '本输出中所有 north_*_netbuy 恒为 null:null=交易所不披露该数据(而非真实零值)。只有南向 south_*_netbuy 的 0 才是真实零值。AI 使用时禁止把 null 当作 0 或“当日无净流入”解读。',
    field_notes: {
      north_sh_turnover: '沪股通(北向)成交总额(亿元),=买入+卖出',
      north_sz_turnover: '深股通(北向)成交总额(亿元),=买入+卖出',
      north_total_turnover: '北向合计成交总额(亿元),=沪+深',
      north_sh_netbuy: '沪股通净买入,2024-08-19起不披露,恒为 null',
      north_sz_netbuy: '深股通净买入,2024-08-19起不披露,恒为 null',
      north_total_netbuy: '北向合计净买入,2024-08-19起不披露,恒为 null',
      south_total_turnover: '南向(港股通)合计成交总额(亿元)',
      south_total_netbuy: '南向(港股通)合计净买入(亿元),仍披露',
      south_sh_netbuy: '港股通(沪)净买入(亿元)',
      south_sz_netbuy: '港股通(深)净买入(亿元)',
    },
    data: [],
  }
  const byGran = {}
  let dataAsof = null
  for (const g of ['month', 'quarter']) {
    const { sorted, asof } = aggregate(rows, g)
    dataAsof = asof
    byGran[g] = { asof, records: sorted.map((b) => buildRecord(b, g, asof)) }
    out.data.push({ granularity: g, asof, records: byGran[g].records })
    if (!asJson) console.log(`\n===== ${g === 'month' ? '按月' : '按季度'} (截止 ${asof}) =====`)
    for (const b of sorted) {
      const rec = buildRecord(b, g, asof)
      if (asJson) continue
      console.log(
        `  ${rec.period.padEnd(10)} 北向成交 ${String(rec.north_total_turnover ?? '-').padStart(8)}亿` +
          ` (沪 ${String(rec.north_sh_turnover ?? '-').padStart(7)} / 深 ${String(rec.north_sz_turnover ?? '-').padStart(7)})` +
          `  南向成交 ${String(rec.south_total_turnover ?? '-').padStart(8)}亿 净买入 ${String(rec.south_total_netbuy ?? '-').padStart(8)}亿  ${rec.period_start}~${rec.period_end}`
      )
    }
  }
  if (asJson) {
    const { data, ...meta } = out
    console.log(
      JSON.stringify({ ...meta, data_asof: dataAsof, months: byGran.month.records, quarters: byGran.quarter.records }, null, 2)
    )
  }
}

main().catch((e) => {
  process.exit(1)
})