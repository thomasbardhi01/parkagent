/**
 * Sign-in code mail via Resend (RESEND_API_KEY). One template, plain and
 * branded — the code is the message. Injectable seam: tests capture sends
 * instead of hitting the network. The code is never logged.
 */

export interface EmailSender {
  sendLoginCode(to: string, code: string): Promise<{ ok: boolean }>;
}

/** The plain branded template, exported so tests can assert its shape. */
export function loginCodeEmail(code: string): { subject: string; html: string; text: string } {
  const subject = `${code} is your ParkAgent sign-in code`;
  const text = [
    `Your ParkAgent sign-in code is ${code}.`,
    "",
    "It expires in 10 minutes. If you didn't request it, ignore this email —",
    "nobody can sign in without the code.",
  ].join("\n");
  const html = `<!doctype html>
<html><body style="margin:0;padding:32px 16px;background:#faf7f2;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1b1a;">
  <div style="max-width:420px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #eee7dc;">
    <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#e0552f;">ParkAgent</p>
    <p style="margin:0 0 20px;font-size:15px;">Here's your sign-in code:</p>
    <p style="margin:0 0 20px;font-size:34px;font-weight:700;letter-spacing:8px;">${code}</p>
    <p style="margin:0;font-size:13px;color:#6b675f;">It expires in 10 minutes. If you didn't request it, ignore this email — nobody can sign in without the code.</p>
  </div>
</body></html>`;
  return { subject, html, text };
}

export function makeResendSender(apiKey: string, from: string): EmailSender {
  return {
    async sendLoginCode(to, code) {
      const { subject, html, text } = loginCodeEmail(code);
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ from, to: [to], subject, html, text }),
        });
        return { ok: response.ok };
      } catch {
        return { ok: false };
      }
    },
  };
}
