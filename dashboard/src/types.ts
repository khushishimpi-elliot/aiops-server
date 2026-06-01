export interface ToolModelBreakdown {
  tool: string
  model: string
  cost_millicents: number
  input_tokens: number
  output_tokens: number
  days_active: number
  session_count?: number
}

export interface DailyUsage {
  date: string
  cost_millicents: number
  input_tokens: number
  output_tokens: number
}

export interface TaskCategoryItem {
  category: string
  session_count: number
  pct: number
}

export interface OrgOverviewResponse {
  period_days: number
  total_cost_millicents: number
  total_input_tokens: number
  total_output_tokens: number
  active_developers: number
  by_tool_model: ToolModelBreakdown[]
  task_categories: TaskCategoryItem[]
  primary_use_case: string | null
  task_diversity_score: number
}

export interface DevSummaryItem {
  user_id: number
  email: string
  enrolled_at: string
  total_cost_millicents: number
  total_input_tokens: number
  total_output_tokens: number
  last_active: string | null
  active_devices: number
}

export interface DevSummaryResponse {
  period_days: number
  developers: DevSummaryItem[]
}

export interface DevDetailResponse {
  user_id: number
  email: string
  enrolled_at: string
  total_cost_millicents: number
  total_input_tokens: number
  total_output_tokens: number
  by_tool_model: ToolModelBreakdown[]
  daily: DailyUsage[]
}
