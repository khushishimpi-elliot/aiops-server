from datetime import date, datetime
from pydantic import BaseModel, EmailStr, Field, ConfigDict


# ---------------------------------------------------------------------------
# Enrollment
# ---------------------------------------------------------------------------

class DiscoverRequest(BaseModel):
    model_config = ConfigDict(strict=True)
    email: EmailStr


class DiscoverResponse(BaseModel):
    allowed: bool


class UserStatusResponse(BaseModel):
    registered: bool


class PasswordAuthRequest(BaseModel):
    model_config = ConfigDict(strict=True)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class PasswordAuthResponse(BaseModel):
    enrollment_token: str
    is_new_user: bool


class SendOtpRequest(BaseModel):
    model_config = ConfigDict(strict=True)
    email: EmailStr


class SendOtpResponse(BaseModel):
    expires_in_seconds: int


class VerifyOtpRequest(BaseModel):
    model_config = ConfigDict(strict=True)
    email: EmailStr
    code: str = Field(pattern=r"^\d{6}$")


class VerifyOtpResponse(BaseModel):
    enrollment_token: str


class EnrollRequest(BaseModel):
    model_config = ConfigDict(strict=True)
    enrollment_token: str
    machine_id: str = Field(pattern=r"^[a-f0-9]{64}$")  # SHA-256 hex digest
    label: str | None = None
    agent_version: str | None = None


class EnrollResponse(BaseModel):
    device_id: int
    user_id: int


# ---------------------------------------------------------------------------
# Agent enrollment — npm package flow (OTP → api_token returned)
# ---------------------------------------------------------------------------

class AgentEnrollRequest(BaseModel):
    model_config = ConfigDict(strict=True)
    enrollment_token: str
    machine_id: str = Field(min_length=1, max_length=256)  # plain hostname-platform, hashed server-side
    hostname: str | None = None
    os: str | None = None


class AgentEnrollResponse(BaseModel):
    api_token: str
    device_id: int
    user_id: int


# ---------------------------------------------------------------------------
# Agent sync — npm package telemetry submission
# ---------------------------------------------------------------------------

class AgentAggregateItem(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    tool: str
    model: str
    category: str | None = None
    sessions: int = Field(ge=0)
    total_turns: int = Field(ge=0)
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    cache_tokens: int = Field(default=0, ge=0)
    cost_usd: float = Field(ge=0.0)
    active_day: int = Field(ge=0)


class AgentSyncRequest(BaseModel):
    enrollment_token: str
    machine_id: str
    hostname: str | None = None
    os: str | None = None
    sent_at: str | None = None
    aggregates: list[AgentAggregateItem]


# ---------------------------------------------------------------------------
# Telemetry  (Step 5 — shapes defined here so imports don't break)
# ---------------------------------------------------------------------------

class DailyRollupRequest(BaseModel):
    model_config = ConfigDict(strict=True)
    device_id: int
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    tool: str
    model: str = ""
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    cache_read_tokens: int = Field(default=0, ge=0)
    cache_write_tokens: int = Field(default=0, ge=0)
    sessions: int = Field(default=1, ge=0)
    turns: int = Field(default=0, ge=0)
    idempotency_key: str = Field(min_length=8, max_length=128)
    agent_version: str | None = None  # reported on every rollup, updates devices.agent_version


class DailyRollupResponse(BaseModel):
    usage_id: int
    cost_millicents: int


# ---------------------------------------------------------------------------
# Query — dashboard read endpoints
# ---------------------------------------------------------------------------

class ToolModelBreakdown(BaseModel):
    tool: str
    model: str
    cost_millicents: int
    input_tokens: int
    output_tokens: int
    days_active: int
    session_count: int = Field(default=0)


class DailyUsage(BaseModel):
    date: date
    cost_millicents: int
    input_tokens: int
    output_tokens: int


class DailyToolRow(BaseModel):
    date: date
    tool: str
    model: str
    session_count: int
    input_tokens: int
    output_tokens: int
    cost_millicents: int


class DevSummaryItem(BaseModel):
    user_id: int
    email: str
    enrolled_at: datetime
    total_cost_millicents: int
    total_input_tokens: int
    total_output_tokens: int
    last_active: date | None   # most recent day of actual usage (usage.date), not upload time
    active_devices: int


class DevSummaryResponse(BaseModel):
    period_days: int
    developers: list[DevSummaryItem]


class TaskCategoryItem(BaseModel):
    category: str
    session_count: int
    pct: int


class DevDetailResponse(BaseModel):
    user_id: int
    email: str
    enrolled_at: datetime
    total_cost_millicents: int
    total_input_tokens: int
    total_output_tokens: int
    total_cache_read_tokens: int = 0
    by_tool_model: list[ToolModelBreakdown]
    daily: list[DailyUsage]
    daily_by_tool: list[DailyToolRow] = []
    task_categories: list[TaskCategoryItem] = []
    team_name: str | None = None
    machine_label: str | None = None
    last_seen_at: datetime | None = None


class CategoryRollupRequest(BaseModel):
    model_config = ConfigDict(strict=True)
    device_id: int
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    categories: dict[str, int]
    idempotency_key: str = Field(min_length=8, max_length=128)


class CategoryRollupResponse(BaseModel):
    ok: bool


class OrgOverviewResponse(BaseModel):
    period_days: int
    total_cost_millicents: int
    total_input_tokens: int
    total_output_tokens: int
    active_developers: int
    by_tool_model: list[ToolModelBreakdown]
    task_categories: list[TaskCategoryItem]
    primary_use_case: str | None
    task_diversity_score: int


# ---------------------------------------------------------------------------
# Admin — management request/response shapes
# ---------------------------------------------------------------------------

class RegisterDomainRequest(BaseModel):
    model_config = ConfigDict(strict=True)
    domain: str = Field(pattern=r"^[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$")


class DomainItem(BaseModel):
    id: int
    domain: str
    created_at: datetime


class UserAdminItem(BaseModel):
    user_id: int
    email: str
    enrolled_at: datetime
    deleted_at: datetime | None
    total_cost_millicents: int
    active_devices: int


class DeviceAdminItem(BaseModel):
    device_id: int
    user_id: int
    user_email: str
    machine_id_prefix: str
    label: str | None
    agent_version: str | None
    last_seen_at: datetime | None
    status: str
    enrolled_at: datetime


class AuditLogItem(BaseModel):
    id: int
    actor: str
    action: str
    target_type: str | None
    target_id: int | None
    detail: dict | None
    created_at: datetime
