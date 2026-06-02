import logging

import httpx

from ..config import Config


async def send_otp_email(config: Config, to: str, code: str) -> bool:
    if not config.resend_api_key:
        logging.warning("RESEND_API_KEY not set — cannot send OTP email")
        return False

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            res = await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {config.resend_api_key}"},
                json={
                    "from": "Elliot AIOps <onboarding@resend.dev>",
                    "to": [to],
                    "subject": "Your AIOps enrollment code",
                    "text": (
                        f"Your AIOps enrollment code is: {code}\n\n"
                        f"Valid for 10 minutes. Do not share it.\n\n"
                        f"Regards,\nElliot Systems AIOps"
                    ),
                },
            )
            if res.status_code != 200:
                logging.error(f"Resend API error {res.status_code}: {res.text}")
                return False
            return True
    except Exception as e:
        logging.error(f"Email send failed: {e}")
        return False
