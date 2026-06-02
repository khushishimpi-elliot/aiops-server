import logging
from functools import lru_cache
from typing import Optional

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
    smtp_user: str = ""
    smtp_password: Optional[SecretStr] = None

    resend_api_key: str = ""

    sentry_dsn: str = ""
    slack_webhook_url: str = ""

    daily_cost_alert_cents: int = 1000       # alert when org daily cost > $10
    developer_spike_multiplier: float = 10.0  # alert when any dev spikes 10x baseline

    @property
    def email_configured(self) -> bool:
        return bool(self.resend_api_key)


@lru_cache(maxsize=1)
def get_config() -> Config:
    config = Config()
    if not config.email_configured:
        logging.warning(
            "EMAIL NOT CONFIGURED: SMTP_USER or SMTP_PASSWORD not set. "
            "OTPs will be logged to console instead. "
            "Set these in Render environment variables to enable email delivery."
        )
    return config
