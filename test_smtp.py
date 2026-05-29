import smtplib

smtp_user = "khushi.shimpi@elliotsystems.com"
smtp_password = input("Paste app password (no spaces): ").strip()

print(f"Trying to login as {smtp_user} ...")
try:
    with smtplib.SMTP("smtp.gmail.com", 587) as server:
        server.starttls()
        server.login(smtp_user, smtp_password)
        print("SUCCESS — credentials work!")
except smtplib.SMTPAuthenticationError as e:
    print(f"FAILED — {e}")
