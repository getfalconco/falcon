import { Resend } from "resend";

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "hello@getfalcon.co";
const FROM_NAME = process.env.RESEND_FROM_NAME ?? "Falcon";

function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  return new Resend(apiKey);
}

export type SendEmailParams = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
};

/**
 * Sends transactional email via Resend from the verified @getfalcon.co domain.
 * Requires RESEND_API_KEY and a verified domain in the Resend dashboard.
 */
export async function sendEmail(params: SendEmailParams): Promise<{ id: string } | null> {
  const resend = getResendClient();
  if (!resend) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const { data, error } = await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    replyTo: params.replyTo,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}
