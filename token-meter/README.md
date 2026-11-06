# token-meter

在 Claude Code 對話欄上方顯示一個 Token 用量儀表板，並提供幾個節約上下文與 token 的工具。

## 功能

**用量**
- **5 小時／7 天額度**：訂閱方案用量上限已用的百分比與重置時間（環形儀表，綠 <70%、黃 ≥70%、紅 ≥90%）
- **上下文**：最近一次請求的上下文大小與模型上限
- **本回合**：你送出一則訊息後，Claude 整個回覆過程的輸入／輸出 token（每次工具呼叫都會重送上下文，所以通常遠大於上下文大小）
- **對話累計**：整個對話（含子代理）的 token 加總與估算花費，依「快取讀取／快取寫入／新輸入／輸出」分色

**節約**
- **上下文組成**：本機估算系統提示、工具定義、MCP、記憶檔、對話訊息各佔多少，並列出最佔空間的 MCP 伺服器（不發送任何請求）
- **立即壓縮**：上下文 ≥50% 時出現，等同 `/compact`
- **輸出瘦身**：Bash 輸出超過 200 行時只給 Claude 前後各 60 行，完整內容存到 `/tmp/token-meter-*.log`，需要時再讀；可隨時開關

右上角「？說明」會逐項解釋每個數字；「收合」會縮成一行摘要，按「展開」恢復。

## 安裝

```
/plugin install token-meter --marketplace kinolan-prog/kino-ai-mod
```

出現「Add marketplace?」時輸入 `y`，再選安裝範圍（Enter 選 user）。

從 shell：

```bash
claude plugin install token-meter --marketplace kinolan-prog/kino-ai-mod
```

在 Claude 桌面版：點輸入框旁的 **+** → **Plugins** → **Add marketplace**，輸入 `kinolan-prog/kino-ai-mod`，再按 **Add plugin**。

## 調整

門檻值在 `hooks/register.tsx` 開頭：
- `WARN_PCT`：顯示壓縮按鈕的上下文百分比（預設 50）
- `TRIM_LINES`、`KEEP_HEAD`、`KEEP_TAIL`：輸出瘦身的行數設定（預設 200／60／60）

## 需求

使用 Claude Code 的 mod（hooks module）功能，屬搶先體驗，請使用最新版 Claude Code。

## 授權

MIT
