
# Easy Forty (Cloudflare Pages + Telnyx)

This project hosts a mobile-first landing page and Cloudflare Pages Functions that:
- Capture a phone number and payout handle with explicit SMS consent
- Send an immediate SMS via Telnyx containing a rotating referral link
- Manage a simple SMS conversation: DONE -> request screenshot -> store MMS -> mark VERIFIED
- Rotate referral links once each hits its configured cap
- Store proof images in Cloudflare R2 and all state in D1

See the ChatGPT message for full step-by-step deployment instructions.
