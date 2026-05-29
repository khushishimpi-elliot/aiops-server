import asyncio
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from ..config import Config

_ALLOWED_DOMAIN = "elliotsystems.com"


def _send_sync(config: Config, to: str, code: str) -> None:
    if not to.lower().endswith(f"@{_ALLOWED_DOMAIN}"):
        raise ValueError(f"Refusing to send OTP to non-{_ALLOWED_DOMAIN} address")

    msg = MIMEMultipart()
    msg["From"] = config.smtp_user
    msg["To"] = to
    msg["Subject"] = "Your AIOps enrollment code"
    msg.attach(MIMEText(
        f"Hello,\n\n"
        f"Your AIOps enrollment code is: {code}\n\n"
        f"Valid for 10 minutes. Do not share it.\n\n"
        f"Regards,\nElliot Systems AIOps",
        "plain",
    ))

    with smtplib.SMTP(config.smtp_host, config.smtp_port) as server:
        server.starttls()
        server.login(config.smtp_user, config.smtp_password.get_secret_value())
        server.sendmail(config.smtp_user, to, msg.as_string())


async def send_otp_email(config: Config, to: str, code: str) -> None:
    await asyncio.to_thread(_send_sync, config, to, code)
