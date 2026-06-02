export interface SessionRecord {
  tool: string;
  model: string;
  sessionId: string;
  projectPath: string;
  projectName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUSD: number;
  tokenSource: 'log_file' | 'tiktoken' | 'estimate';
  sessionDate: string;
  sessionTimestamp: number;
  sessionEndTimestamp?: number;
  turnCount: number;
  userTurnCount?: number;
  firstPrompt?: string;
  sentToServer: 0;
}

export interface AdapterStats {
  processed: number;
  skipped: number;
  errors: number;
}

export interface AdapterResult {
  sessions: SessionRecord[];
  stats: AdapterStats;
}

export const EMPTY_RESULT: AdapterResult = {
  sessions: [],
  stats: { processed: 0, skipped: 0, errors: 0 },
};

export interface AiopsConfig {
  serverUrl: string;
  enrollmentToken: string;
  machineId: string;
  enrolledAt: string;
  developerName?: string;
}

export interface DailyAggregate {
  date: string;
  tool: string;
  model: string;
  category: string;
  sessions: number;
  total_turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  cost_usd: number;
  active_day: number;
}

export interface SyncResult {
  success: boolean;
  aggregatesSent: number;
  daysIncluded: number;
  error?: string;
  dryRun: boolean;
  preview?: DailyAggregate[];
}

export interface HistoricalSummary {
  totalSessions: number;
  totalTokens: number;
  totalCostUsd: number;
  byDay: Array<{
    date: string;
    sessions: number;
    tokens: number;
    costUsd: number;
  }>;
  byWeek: Array<{
    week: string;
    sessions: number;
    tokens: number;
    costUsd: number;
  }>;
  byTool: Array<{
    tool: string;
    sessions: number;
    tokens: number;
    costUsd: number;
  }>;
  byModel: Array<{
    model: string;
    sessions: number;
    tokens: number;
    costUsd: number;
  }>;
}
