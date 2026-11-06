export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Meter = {
  startedAt: number
  total: Tokens
  last: Tokens | null
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  limits: Limit[]
  costUsd?: number
}

/** 上下文組成（本機估算） */
export type Breakdown = {
  categories: { name: string; tokens: number }[]
  free: number
  window: number
  autoCompactAt?: number
  mcpServers: { name: string; tokens: number; tools: number }[]
}

/** Bash 輸出瘦身統計 */
export type TrimStats = { count: number; savedChars: number; lastPath?: string }

declare module 'claude-code' {
  interface PluginState {
    'token-meter': {
      meter: Meter | null
      isHidden: boolean
      breakdown: Breakdown | null
      isTrimOn: boolean
      trim: TrimStats
      isHelpOpen: boolean
    }
  }
}
