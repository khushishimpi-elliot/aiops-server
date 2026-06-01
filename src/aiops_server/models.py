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
# Telemetry  (Step 5 — shapes defined here so imports don't break)
# ---------------------------------------------------------------------------

class DailyRollupRequest(BaseModel):
    model_config = ConfigDict(strict=True)
    device_id: int
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    tool: str
    model: str
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
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


class DailyUsage(BaseModel):
    date: date
    cost_millicents: int
    input_tokens: int
    output_tokens: int


class DevSummaryItem(BaseModel):
    user_id: int
    email: str
    enrolled_at: datetime
    total_cost_millicents: int
    total_input_tokens: int
    total_output_tokens: int
    last_active: datetime | None
    active_devices: int


class DevSummaryResponse(BaseModel):
    period_days: int
    developers: list[DevSummaryItem]


class DevDetailResponse(BaseModel):
    user_id: int
    email: str
    enrolled_at: datetime
    total_cost_millicents: int
    total_input_tokens: int
    total_output_tokens: int
    by_tool_model: list[ToolModelBreakdown]
    daily: list[DailyUsage]


class TaskCategoryItem(BaseModel):
    category: str
    session_count: int
    pct: int


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
