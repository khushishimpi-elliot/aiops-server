from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Config(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    database_url: str
    admin_password_hash: SecretStr
    session_secret: SecretStr

    admin_email: str = "admin@elliotsystems.com"
    session_lifetime_hours: int = 8
    cookie_secure: bool = False  # set True on Render (HTTPS)

    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_user: str          # sender address, e.g. pratik.pawar@elliotsystems.com
    smtp_password: SecretStr  # app password

    sentry_dsn: str = ""
    slack_webhook_url: str = ""

    daily_cost_alert_cents: int = 1000       # alert when org daily cost > $10
    developer_spike_multiplier: float = 10.0  # alert when any dev spikes 10x baseline


@lru_cache(maxsize=1)
def get_config() -> Config:
    return Config()
