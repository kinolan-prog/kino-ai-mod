import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { Breakdown, Meter, Tokens } from '../types'

const meter = atom({ plugin: 'token-meter', key: 'meter' } as const, null)
const isHidden = atom({ plugin: 'token-meter', key: 'isHidden' } as const, false)
const breakdown = atom({ plugin: 'token-meter', key: 'breakdown' } as const, null)
const isTrimOn = atom({ plugin: 'token-meter', key: 'isTrimOn' } as const, true)
const trim = atom({ plugin: 'token-meter', key: 'trim' } as const, { count: 0, savedChars: 0 })
const isHelpOpen = atom({ plugin: 'token-meter', key: 'isHelpOpen' } as const, false)

// ---- 節約設定 ----
const WARN_PCT = 50 // 上下文達此百分比時顯示「壓縮」按鈕
const TRIM_LINES = 200 // Bash 輸出超過此行數才瘦身
const KEEP_HEAD = 60
const KEEP_TAIL = 60

const CAT_COLORS = ['#7c8cf8', '#38bdf8', '#f5a524', '#b48cf2', '#30a46c', '#e5484d', '#14b8a6', '#ec4899']

// 本機估算上下文組成（不送任何請求，免費）
const measureBreakdown = async ($: EngineInterface): Promise<Breakdown | null> => {
  const u = await $.session.usage({ breakdown: 'summary' })
  const b = u.context.breakdown
  if (!b) return null
  const servers = new Map<string, { tokens: number; tools: number }>()
  for (const t of b.mcpTools) {
    if (!t.isLoaded) continue
    const s = servers.get(t.serverName) ?? { tokens: 0, tools: 0 }
    servers.set(t.serverName, { tokens: s.tokens + t.tokens, tools: s.tools + 1 })
  }
  return {
    categories: b.categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .map(c => ({ name: c.name, tokens: c.tokens }))
      .sort((a, z) => z.tokens - a.tokens),
    free: b.categories.filter(c => c.kind === 'free').reduce((n, c) => n + c.tokens, 0),
    window: b.rawMaxTokens,
    autoCompactAt: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
    mcpServers: [...servers.entries()]
      .map(([name, s]) => ({ name, ...s }))
      .sort((a, z) => z.tokens - a.tokens),
  }
}

// 可伸縮的堆疊條：寬 VW 的 viewBox、不保持比例，Svg 只給高度就會撐滿所在欄寬
const VW = 1200
const barSvg = (segments: [number, string][], max: number, markAt?: number): string => {
  let x = 0
  const rects = segments
    .map(([n, color]) => {
      const w = (n / Math.max(max, 1)) * VW
      const r = w > 0 ? `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${BAR_H}" fill="${color}"/>` : ''
      x += w
      return r
    })
    .join('')
  const mark = markAt !== undefined ? `<rect x="${((markAt / Math.max(max, 1)) * VW - 3).toFixed(1)}" y="0" width="6" height="${BAR_H}" fill="#e5484d"/>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${VW}" height="${BAR_H}" viewBox="0 0 ${VW} ${BAR_H}" preserveAspectRatio="none">` +
    `<rect width="${VW}" height="${BAR_H}" fill="#8a8a8a" fill-opacity="0.2"/>${rects}${mark}` +
    `</svg>`
  )
}

const breakdownSvg = (b: Breakdown): string =>
  barSvg(b.categories.map((c, i) => [c.tokens, CAT_COLORS[i % CAT_COLORS.length]]), b.window, b.autoCompactAt)

// ---- 中文化 ----
const CAT_ZH: Record<string, string> = {
  Messages: '對話訊息',
  'MCP tools': 'MCP 工具',
  'System tools': '系統工具',
  'System prompt': '系統提示',
  Skills: '技能清單',
  'Memory files': '記憶檔',
  'Custom agents': '自訂代理',
  'Slash commands': '斜線指令',
  'Tool results': '工具結果',
}
const catName = (n: string): string => CAT_ZH[n] ?? n

const SERVER_ZH: Record<string, string> = {
  Claude_Browser: '內建瀏覽器',
  'claude-artifacts': 'Artifacts 發布',
  'claude-in-chrome': 'Chrome 擴充',
  'plugin-authoring': 'Mod 開發',
  'scheduled-tasks': '排程任務',
  'mcp-registry': '連接器目錄',
  terminal: '終端機',
  visualize: '圖表元件',
}
const serverName = (n: string): string => {
  if (SERVER_ZH[n]) return SERVER_ZH[n]
  if (n.startsWith('ccd_')) return `App 內建(${n.slice(4)})`
  if (/^[0-9a-f]{8}-/.test(n)) return `連接器 ${n.slice(0, 4)}`
  return n
}

const HELP: [string, string][] = [
  ['5小時／7天額度', '訂閱方案的用量上限已用百分比與重置時間。綠 <70%、黃 ≥70%、紅 ≥90%。'],
  ['上下文（環）', '最近一次請求實際送出的上下文大小 ÷ 模型上限，由 API 回報，最準確。'],
  ['本回合', '你送出一則訊息後 Claude 回覆的整個過程。每呼叫一次工具就會重送一次上下文，所以會遠大於上下文大小。'],
  ['對話累計／花費', '這個對話所有回合加總（含子代理），花費依 API 價格估算。/clear 後歸零。'],
  ['快取讀取', '重複送出的上下文命中快取，價格約為新輸入的 1/10。比例越高越省。'],
  ['上下文組成', '本機估算各類內容佔多少，與上方「上下文」略有出入。紅線是自動壓縮的觸發點。'],
  ['MCP 佔用', '連接器的工具說明每次請求都會送出。不常用的可在連接器設定關閉；「App 內建」的無法關閉。'],
  ['立即壓縮', '上下文 ≥50% 時出現，等同 /compact，把舊對話摘要化以騰出空間。'],
  ['輸出瘦身', 'Bash 輸出超過 200 行時只給 Claude 前後各 60 行，完整內容存到 /tmp，需要時再讀。'],
  ['收合', '收合成一行摘要，按「展開」即可恢復。'],
]

const compactNow = async ($: EngineInterface): Promise<void> => {
  $.ui.toast('正在壓縮上下文…')
  try {
    const r = await $.session.compact()
    $.ui.toast(r.skip ? '壓縮被略過' : '上下文已壓縮')
    const b = await measureBreakdown($)
    if (b) await update($, breakdown, () => b)
  } catch {
    $.ui.toast('Claude 回覆中無法壓縮，請等這輪結束再按')
  }
}

// 長輸出只留頭尾，中間省略
const trimText = (s: string): { text: string; cut: number } | null => {
  const lines = s.split('\n')
  if (lines.length <= TRIM_LINES) return null
  const cut = lines.length - KEEP_HEAD - KEEP_TAIL
  return { text: [...lines.slice(0, KEEP_HEAD), `<<<CUT:${cut}>>>`, ...lines.slice(-KEEP_TAIL)].join('\n'), cut }
}

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const empty = (startedAt: number): Meter => ({ startedAt, total: zero(), last: null, contextWindow: 0, limits: [] })

const fmt = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

const allInput = (t: Tokens): number => t.input + t.cacheRead + t.cacheWrite

const limitName: Record<string, string> = { five_hour: '5小時', seven_day: '7天', spend_limit: '花費' }

const resetIn = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  if (mins >= 1440) return ` (${Math.round(mins / 1440)}天後重置)`
  if (mins >= 60) return ` (${Math.floor(mins / 60)}h${mins % 60}m後重置)`
  return ` (${mins}m後重置)`
}


// ---- 視覺化 ----
type Gauge = { key: string; label: string; percent?: number; sub: string }

const RING = 56
const BAR_H = 10
const SEG = { cacheRead: '#7c8cf8', cacheWrite: '#b48cf2', input: '#38bdf8', output: '#f5a524' } as const

const pctHex = (p: number): string => (p >= 90 ? '#e5484d' : p >= 70 ? '#e2a03f' : '#30a46c')

const sumAll = (t: Tokens): number => allInput(t) + t.output

const tokenLine = (t: Tokens): string => `輸入 ${fmt(allInput(t))} / 輸出 ${fmt(t.output)}`

const textBar = (p: number, w: number): string => {
  const n = Math.max(0, Math.min(w, Math.round((p / 100) * w)))
  return '█'.repeat(n) + '░'.repeat(w - n)
}

const ringSvg = (p: number | undefined): string => {
  const r = 22
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, p ?? 0))
  const color = p === undefined ? '#8a8a8a' : pctHex(p)
  const label = p === undefined ? '—' : `${Math.round(p)}%`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${RING}" height="${RING}" viewBox="0 0 56 56">` +
    `<circle cx="28" cy="28" r="${r}" fill="none" stroke="#8a8a8a" stroke-opacity="0.25" stroke-width="6"/>` +
    `<circle cx="28" cy="28" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" ` +
    `stroke-dasharray="${((c * v) / 100).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 28 28)"/>` +
    `<text x="28" y="32" text-anchor="middle" font-family="-apple-system,Segoe UI,sans-serif" font-size="12" font-weight="600" fill="${color}">${label}</text>` +
    `</svg>`
  )
}

const stackSvg = (t: Tokens, max: number): string =>
  barSvg(
    [
      [t.cacheRead, SEG.cacheRead],
      [t.cacheWrite, SEG.cacheWrite],
      [t.input, SEG.input],
      [t.output, SEG.output],
    ],
    max,
  )

type Figures ={ context: SessionContextUsage; rateLimits: SessionRateLimit[]; cost?: SessionCost; startedAt?: number }

// Fold the engine's figures into the stored meter; a new startedAt (/clear, new session) restarts the totals.
const absorb = (prev: Meter | null, u: Figures): Meter => {
  const isNew = prev === null || (u.startedAt !== undefined && u.startedAt !== prev.startedAt)
  const base = isNew ? empty(u.startedAt ?? 0) : prev
  return {
    ...base,
    contextTokens: u.context.tokens,
    contextWindow: u.context.window,
    contextPercent: u.context.percent,
    limits: u.rateLimits.length > 0 ? u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })) : base.limits,
    costUsd: u.cost?.usd ?? base.costUsd,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'token-meter', description: '顯示/隱藏對話欄上方的 token 用量列' })
    const u = await $.session.usage()
    await update($, meter, prev => absorb(prev, u))
    const b = await measureBreakdown($)
    if (b) await update($, breakdown, () => b)
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, meter, prev => absorb(prev, e))
    if (e.changed.includes('context')) {
      const b = await measureBreakdown($)
      if (b) await update($, breakdown, () => b)
    }
    return next(e)
  })

  // Bash 長輸出瘦身：只留頭尾給模型，完整內容存檔供需要時讀取
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || !(await read($, isTrimOn))) return ran
    const out = ran.result
    if (out.isImage || out.backgroundTaskId) return ran
    const so = trimText(out.stdout)
    const se = trimText(out.stderr)
    if (!so && !se) return ran

    const path = `/tmp/token-meter-${Math.round(await $.clock.now())}.log`
    try {
      await $.fs.write(path, `$ ${e.command}\n\n--- stdout ---\n${out.stdout}\n\n--- stderr ---\n${out.stderr}\n`)
    } catch {
      return ran // 存不了完整內容就不瘦身，避免資訊遺失
    }
    const note = (n: number) => `... [token-meter 省略中間 ${n} 行；完整輸出在 ${path}，需要時用 Read 讀取特定範圍] ...`
    const stdout = so ? so.text.replace(/<<<CUT:\d+>>>/, note(so.cut)) : out.stdout
    const stderr = se ? se.text.replace(/<<<CUT:\d+>>>/, note(se.cut)) : out.stderr
    const saved = out.stdout.length + out.stderr.length - stdout.length - stderr.length
    await update($, trim, t => ({ count: t.count + 1, savedChars: t.savedChars + saved, lastPath: path }))
    return { result: { ...out, stdout, stderr } }
  })


  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = result.usage ?? e.usage
    if (usage) {
      const t: Tokens = {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
      }
      await update($, meter, prev => {
        const m = prev ?? empty(0)
        return {
          ...m,
          total: {
            input: m.total.input + t.input,
            output: m.total.output + t.output,
            cacheRead: m.total.cacheRead + t.cacheRead,
            cacheWrite: m.total.cacheWrite + t.cacheWrite,
          },
          // 「本次」= 主對話最後一輪；子代理的用量只計入累計
          last: e.agentId ? m.last : t,
        }
      })
    }
    return result
  })

  on('command.run', { name: 'token-meter' }, async ($, e, next) => {
    const hidden = await read($, isHidden)
    await update($, isHidden, () => !hidden)
    return { text: hidden ? 'Token meter 已顯示' : 'Token meter 已隱藏（再輸入 /token-meter 可顯示）' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, meter)
    if (e.props.hasSurvey || m === null) {
      return next(e)
    }
    // 收合狀態：只留一行摘要與「展開」按鈕，不會完全消失
    if (await read($, isHidden)) {
      const { Box, Text, Button } = $.ui.resolve(e)
      const five = m.limits.find(l => l.kind === 'five_hour')
      const summary = [
        five ? `5小時 ${five.percentUsed}%` : null,
        m.contextPercent !== undefined ? `上下文 ${m.contextPercent}%` : null,
        m.costUsd !== undefined ? `$${m.costUsd.toFixed(2)}` : null,
      ]
        .filter(Boolean)
        .join('  ·  ')
      return (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="caption" dimColor>{`Token 用量　${summary}`}</Text>
          <Button key="tm-show" label="展開" onPress={() => update($, isHidden, () => false)} />
        </Box>
      )
    }
    const now = await $.clock.now()

    const gauges: Gauge[] = m.limits.map(l => ({
      key: l.kind,
      label: `${limitName[l.kind] ?? l.kind}額度`,
      percent: l.percentUsed,
      sub: resetIn(l.resetsAt, now),
    }))
    gauges.push({
      key: 'context',
      label: '上下文',
      percent: m.contextPercent,
      sub: m.contextTokens !== undefined ? `${fmt(m.contextTokens)}/${fmt(m.contextWindow)}` : `—/${fmt(m.contextWindow)}`,
    })
    const cost = m.costUsd !== undefined ? `$${m.costUsd.toFixed(2)}` : undefined

    const b = await read($, breakdown)
    const trimOn = await read($, isTrimOn)
    const t = await read($, trim)
    const isWarn = (m.contextPercent ?? 0) >= WARN_PCT
    const topCats = b ? b.categories.slice(0, 5) : []
    const topMcp = b ? b.mcpServers.slice(0, 3) : []
    const mcpText = topMcp.length > 0 ? topMcp.map(s => `${serverName(s.name)} ${fmt(s.tokens)}`).join('、') : '無（或已延遲載入）'
    const trimText2 = `輸出瘦身 ${trimOn ? '開' : '關'}${t.count > 0 ? ` · 已省 ${t.count} 次 ≈${fmt(Math.round(t.savedChars / 4))} token` : ''}`
    const onCompact = () => compactNow($)
    const onTrim = () => update($, isTrimOn, v => !v)

    // 終端機：沒有 Svg，用方塊字元畫條狀圖
    if (e.surface === 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Box flexWrap="wrap" columnGap={2}>
            {m.limits.length === 0 ? <Text dimColor>額度（尚無資料）</Text> : null}
            {gauges.map(g => (
              <Text key={g.key}>
                <Text dimColor>{`${g.label} `}</Text>
                <Text color={g.percent === undefined ? 'subtle' : pctHex(g.percent)}>{textBar(g.percent ?? 0, 10)}</Text>
                <Text>{` ${g.percent === undefined ? '—' : `${g.percent}%`} `}</Text>
                <Text dimColor>{g.sub}</Text>
              </Text>
            ))}
          </Box>
          <Box columnGap={2} flexWrap="wrap">
            <Text>
              <Text dimColor>本回合 </Text>
              {m.last ? <Text>{tokenLine(m.last)}</Text> : <Text dimColor>—</Text>}
            </Text>
            <Text>
              <Text dimColor>累計 </Text>
              <Text>{tokenLine(m.total)}</Text>
              {cost ? <Text dimColor>{`  ${cost}`}</Text> : null}
            </Text>
          </Box>
          {b ? (
            <Text>
              <Text dimColor>組成 </Text>
              {topCats.map((c, i) => (
                <Text key={c.name}>
                  <Text color={CAT_COLORS[i % CAT_COLORS.length]}>■</Text>
                  {` ${catName(c.name)} ${fmt(c.tokens)}  `}
                </Text>
              ))}
              <Text dimColor>{`│ MCP 佔用前三：${mcpText}`}</Text>
            </Text>
          ) : null}
          <Box columnGap={2}>
            {isWarn ? <Button key="tm-compact" label={`⚠ 上下文 ${m.contextPercent}% · 壓縮`} onPress={onCompact} /> : null}
            <Button key="tm-trim" label={trimText2} onPress={onTrim} />
          </Box>
        </Box>
      )
    }

    // 桌面 / VS Code / 手機：三列對齊 —— 標題列、用量列、上下文組成列
    const { Box, Text, Svg, Button } = $.ui.resolve(e)
    const totalMax = Math.max(sumAll(m.total), 1)
    const lastMax = m.last ? Math.max(sumAll(m.last), 1) : 1
    const helpOpen = await read($, isHelpOpen)
    const onHelp = () => update($, isHelpOpen, v => !v)
    const onHide = () => update($, isHidden, () => true)
    const legend = (items: [string, string][]) => (
      <Text size="caption">
        {items.map(([color, label]) => (
          <Text key={label} size="caption">
            <Text size="caption" color={color}>■</Text>
            <Text size="caption" dimColor>{` ${label}   `}</Text>
          </Text>
        ))}
      </Text>
    )

    return (
      <Box flexDirection="column" gap="sm">
        {/* 標題列：右上角說明 */}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="caption" bold>Token 用量儀表板</Text>
          <Box flexDirection="row" gap="xs">
            <Button key="tm-help" label={helpOpen ? '✕ 關閉說明' : '？說明'} onPress={onHelp} />
            <Button key="tm-hide" label="收合" onPress={onHide} />
          </Box>
        </Box>

        {helpOpen ? (
          <Box flexDirection="column" gap="xs" padding="sm" borderStyle="round" borderDimColor>
            {HELP.map(([title, body]) => (
              <Text key={title} size="caption">
                <Text size="caption" bold>{`${title}　`}</Text>
                <Text size="caption" dimColor>{body}</Text>
              </Text>
            ))}
          </Box>
        ) : null}

        {/* 用量列：左側三個環，右側 token 條 */}
        <Box flexDirection="row" gap="lg" alignItems="center">
          <Box flexDirection="row" gap="md">
            {m.limits.length === 0 ? (
              <Box flexDirection="column" alignItems="center">
                <Svg source={ringSvg(undefined)} alt="額度尚無資料" width={RING} height={RING} />
                <Text size="caption" dimColor>額度</Text>
                <Text size="caption" dimColor>尚無資料</Text>
              </Box>
            ) : null}
            {gauges.map(g => (
              <Box key={g.key} flexDirection="column" alignItems="center">
                <Svg
                  source={ringSvg(g.percent)}
                  alt={`${g.label} ${g.percent === undefined ? '尚無資料' : `${g.percent}%`}`}
                  width={RING}
                  height={RING}
                />
                <Text size="caption">{g.label}</Text>
                <Text size="caption" dimColor>{g.sub.trim().replace(/[()]/g, '') || ' '}</Text>
              </Box>
            ))}
          </Box>
          <Box flexDirection="column" flexGrow={1} gap="xs">
            <Text size="caption">
              <Text size="caption" dimColor>本回合　</Text>
              {m.last ? tokenLine(m.last) : '—'}
            </Text>
            <Svg source={stackSvg(m.last ?? zero(), lastMax)} alt={m.last ? `本回合 ${tokenLine(m.last)}` : '本回合尚無資料'} height={BAR_H} />
            <Text size="caption">
              <Text size="caption" dimColor>對話累計　</Text>
              {tokenLine(m.total)}
              {cost ? <Text size="caption" dimColor>{`  ·  花費 ${cost}`}</Text> : null}
            </Text>
            <Svg source={stackSvg(m.total, totalMax)} alt={`對話累計 ${tokenLine(m.total)}`} height={BAR_H} />
            {legend([
              [SEG.cacheRead, '快取讀取'],
              [SEG.cacheWrite, '快取寫入'],
              [SEG.input, '新輸入'],
              [SEG.output, '輸出'],
            ])}
          </Box>
        </Box>

        {/* 上下文組成列：左側組成條，右側節約按鈕 */}
        <Box flexDirection="row" gap="lg" alignItems="center">
          <Box flexDirection="column" flexGrow={1} gap="xs">
            <Text size="caption">
              <Text size="caption" dimColor>上下文組成（估算）　</Text>
              {b ? `${fmt(b.window - b.free)} / ${fmt(b.window)}` : '計算中…'}
              {b?.autoCompactAt !== undefined ? <Text size="caption" dimColor>{`  ·  紅線＝${fmt(b.autoCompactAt)} 時自動壓縮`}</Text> : null}
            </Text>
            {b ? <Svg source={breakdownSvg(b)} alt={`上下文組成 ${topCats.map(c => `${catName(c.name)} ${fmt(c.tokens)}`).join('，')}`} height={BAR_H} /> : null}
            {legend(topCats.map((c, i) => [CAT_COLORS[i % CAT_COLORS.length], `${catName(c.name)} ${fmt(c.tokens)}`]))}
            <Text size="caption">
              <Text size="caption" dimColor>MCP 佔用前三　</Text>
              {mcpText}
            </Text>
          </Box>
          <Box flexDirection="column" gap="xs" alignItems="flex-end">
            {isWarn ? <Button key="tm-compact" label={`⚠ 上下文 ${m.contextPercent}%・立即壓縮`} onPress={onCompact} /> : null}
            <Button key="tm-trim" label={trimText2} onPress={onTrim} />
          </Box>
        </Box>
      </Box>
    )
  })
}
