// Sends the login code. Without SMTP settings the server runs in "dev login" mode:
// the code is returned to the browser and printed to the log instead of being emailed.
import nodemailer from 'nodemailer';

export const smtpConfigured = () => !!process.env.SMTP_HOST;

let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

export async function sendCode(email, code) {
  if (!smtpConfigured()) {
    console.log(`[dev login] code for ${email}: ${code}`);
    return { delivered: false };
  }
  await getTransport().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: `Код входа в content lens: ${code}`,
    text: `Ваш код: ${code}\n\nКод действует 10 минут. Если вы не запрашивали вход, просто проигнорируйте письмо.`,
  });
  return { delivered: true };
}
