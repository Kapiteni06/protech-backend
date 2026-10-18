// Sends the shop's emails over SMTP (works with Brevo, Gmail, Outlook, Zoho, Mailgun, ...).
//
// Settings (environment variables):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS   your SMTP server and login
//   SMTP_SECURE        "true" for port 465 (set automatically for 465), otherwise leave empty
//   EMAIL_FROM         who the emails come from, e.g.  ProTech <you@example.com>
//   FRONTEND_URL       your website, used for links in emails (default https://protech.free.je)
//   ORDER_NOTIFY_EMAIL optional: also send every new order to this address (e.g. your own)
//
// Emails are sent in the background, so a slow or broken mail server never makes
// sign-up, checkout or anything else slow or fail.

const nodemailer = require("nodemailer");

const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "").trim();
const SMTP_SECURE = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || SMTP_PORT === 465;
const EMAIL_FROM = String(process.env.EMAIL_FROM || SMTP_USER || "").trim();
const FRONTEND_URL = String(process.env.FRONTEND_URL || "https://protech.free.je").trim().replace(/\/+$/, "");
const ORDER_NOTIFY_EMAIL = String(process.env.ORDER_NOTIFY_EMAIL || "").trim();
const SHOP_NAME = String(process.env.SHOP_NAME || "ProTech").trim();

let transporter = null;
let lastError = "";
let lastSuccessAt = "";

function isConfigured() {
  return Boolean(SMTP_HOST && SMTP_PORT > 0 && SMTP_USER && SMTP_PASS && EMAIL_FROM);
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // Fail fast instead of hanging for minutes when the server can't be reached.
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000
    });
  }
  return transporter;
}

function explainError(error) {
  const message = String(error?.message || error || "Unknown error");
  const code = String(error?.code || "");

  if (code === "EAUTH" || /auth|535|credentials/i.test(message)) {
    return `Login to the SMTP server was refused. Check SMTP_USER and SMTP_PASS. (${message})`;
  }
  if (["ETIMEDOUT", "ECONNREFUSED", "ESOCKET", "ECONNECTION", "EDNS"].includes(code) || /timeout|connect/i.test(message)) {
    return `Could not connect to ${SMTP_HOST}:${SMTP_PORT}. On Render's free plan ports 25, 465 and 587 are blocked: use port 2525 (Brevo supports it). (${message})`;
  }
  if (/sender|from address|not.*verified|550|553/i.test(message)) {
    return `The SMTP server rejected the sender. EMAIL_FROM must be an address you verified with your email provider. (${message})`;
  }
  return message;
}

async function send({ to, subject, text, html }) {
  if (!isConfigured()) {
    return { sent: false, error: "Email is not set up (SMTP_HOST, SMTP_USER, SMTP_PASS and EMAIL_FROM are needed)." };
  }

  try {
    const info = await getTransporter().sendMail({ from: EMAIL_FROM, to, subject, text, html });
    lastSuccessAt = new Date().toISOString();
    lastError = "";
    return { sent: true, messageId: info?.messageId || "" };
  } catch (error) {
    lastError = explainError(error);
    console.error(`Email "${subject}" to ${to} failed: ${lastError}`);
    return { sent: false, error: lastError };
  }
}

// Fire-and-forget: never throws, never blocks the request.
function sendInBackground(message) {
  if (!isConfigured() || !message.to) {
    return false;
  }
  setImmediate(() => {
    send(message).catch(() => {});
  });
  return true;
}

async function verify() {
  if (!isConfigured()) {
    console.warn("Email: SMTP is not configured, so no emails will be sent (welcome, password reset, orders).");
    return { ok: false, error: "not configured" };
  }
  try {
    await getTransporter().verify();
    console.log(`Email: connected to ${SMTP_HOST}:${SMTP_PORT}, sending as ${EMAIL_FROM}.`);
    return { ok: true };
  } catch (error) {
    lastError = explainError(error);
    console.error(`Email: SMTP check failed: ${lastError}`);
    return { ok: false, error: lastError };
  }
}

function status() {
  return {
    configured: isConfigured(),
    host: SMTP_HOST || null,
    port: isConfigured() ? SMTP_PORT : null,
    from: EMAIL_FROM || null,
    lastError: lastError || null,
    lastSuccessAt: lastSuccessAt || null
  };
}

// ---------- Templates ----------

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(value) {
  return `$${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function layout({ title, intro, bodyHtml = "", button, footer }) {
  const buttonHtml = button
    ? `<p style="margin:28px 0"><a href="${escapeHtml(button.url)}" style="background:#4f46e5;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">${escapeHtml(button.label)}</a></p>`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#f4f5fb;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fb;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:#111827;padding:18px 28px"><a href="${escapeHtml(FRONTEND_URL)}" style="color:#ffffff;text-decoration:none;font-size:20px;font-weight:700">${escapeHtml(SHOP_NAME)}</a></td></tr>
<tr><td style="padding:28px">
<h1 style="font-size:22px;margin:0 0 12px">${escapeHtml(title)}</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 8px">${intro}</p>
${bodyHtml}
${buttonHtml}
<p style="font-size:13px;line-height:1.6;color:#6b7280;margin:24px 0 0">${footer || `Thanks for shopping with ${escapeHtml(SHOP_NAME)}.`}</p>
</td></tr>
</table>
<p style="font-size:12px;color:#9ca3af;margin:16px 0 0"><a href="${escapeHtml(FRONTEND_URL)}" style="color:#9ca3af">${escapeHtml(FRONTEND_URL.replace(/^https?:\/\//, ""))}</a></p>
</td></tr>
</table>
</body></html>`;
}

function orderTableHtml(order) {
  const rows = (order.items || [])
    .map(
      (item) => `<tr>
<td style="padding:8px 0;border-bottom:1px solid #eef0f4">${escapeHtml(item.name)} &times; ${Number(item.quantity || 0)}</td>
<td style="padding:8px 0;border-bottom:1px solid #eef0f4;text-align:right">${money(Number(item.price || 0) * Number(item.quantity || 0))}</td>
</tr>`
    )
    .join("");
  const discount = Number(order.discount || 0)
    ? `<tr><td style="padding:6px 0;color:#059669">Discount${order.coupon?.code ? ` (${escapeHtml(order.coupon.code)})` : ""}</td><td style="padding:6px 0;text-align:right;color:#059669">&minus;${money(order.discount)}</td></tr>`
    : "";
  const delivery = order.delivery && (order.delivery.address || order.delivery.city || order.delivery.country)
    ? `<p style="font-size:14px;line-height:1.6;margin:16px 0 0"><strong>Delivery to:</strong> ${escapeHtml([order.delivery.address, order.delivery.city, order.delivery.country].filter(Boolean).join(", "))}</p>`
    : "";
  const payment = order.paymentMethod
    ? `<p style="font-size:14px;line-height:1.6;margin:4px 0 0"><strong>Payment:</strong> ${escapeHtml(String(order.paymentMethod).replace(/-/g, " "))}</p>`
    : "";

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:16px 0 0">
${rows}
<tr><td style="padding:6px 0;color:#6b7280">Subtotal</td><td style="padding:6px 0;text-align:right;color:#6b7280">${money(order.subtotal)}</td></tr>
${discount}
<tr><td style="padding:8px 0;font-weight:700">Total</td><td style="padding:8px 0;text-align:right;font-weight:700">${money(order.total)}</td></tr>
</table>${delivery}${payment}`;
}

function orderText(order) {
  const lines = (order.items || []).map(
    (item) => `- ${item.name} x ${item.quantity}: ${money(Number(item.price || 0) * Number(item.quantity || 0))}`
  );
  lines.push(`Subtotal: ${money(order.subtotal)}`);
  if (Number(order.discount || 0)) {
    lines.push(`Discount: -${money(order.discount)}`);
  }
  lines.push(`Total: ${money(order.total)}`);
  if (order.delivery && (order.delivery.address || order.delivery.city)) {
    lines.push(`Delivery to: ${[order.delivery.address, order.delivery.city, order.delivery.country].filter(Boolean).join(", ")}`);
  }
  return lines.join("\n");
}

const STATUS_TEXT = {
  pending: "We received your order and will start on it soon.",
  processing: "We're preparing your order.",
  shipped: "Your order is on its way.",
  delivered: "Your order was delivered. Enjoy!",
  cancelled: "Your order was cancelled. If this is unexpected, just reply to this email."
};

// ---------- Messages ----------

function welcome(user) {
  const name = user.name || "there";
  return sendInBackground({
    to: user.email,
    subject: `Welcome to ${SHOP_NAME}`,
    text: `Hi ${name},\n\nYour ${SHOP_NAME} account was created with ${user.email}.\n\nStart shopping: ${FRONTEND_URL}/\n\nThanks for joining!`,
    html: layout({
      title: `Welcome, ${name}!`,
      intro: `Your ${escapeHtml(SHOP_NAME)} account is ready. You signed up with <strong>${escapeHtml(user.email)}</strong>.`,
      button: { label: "Start shopping", url: `${FRONTEND_URL}/` },
      footer: "If you didn't create this account, you can ignore this email."
    })
  });
}

function resetLink(user, token) {
  const params = new URLSearchParams({ reset: "1", email: user.email, token });
  return `${FRONTEND_URL}/auth.html?${params.toString()}`;
}

function passwordReset(user, token) {
  const link = resetLink(user, token);
  return sendInBackground({
    to: user.email,
    subject: `Reset your ${SHOP_NAME} password`,
    text: `Hi ${user.name || "there"},\n\nOpen this link to choose a new password (it works for 30 minutes):\n${link}\n\nOr enter this reset code on the sign-in page: ${token}\n\nIf you didn't ask for this, ignore this email. Your password stays the same.`,
    html: layout({
      title: "Reset your password",
      intro: "Someone (hopefully you) asked to reset the password for your account. The button works for <strong>30 minutes</strong>.",
      button: { label: "Choose a new password", url: link },
      bodyHtml: `<p style="font-size:13px;line-height:1.6;color:#6b7280;margin:16px 0 0">Button not working? Enter this reset code on the sign-in page:<br><code style="font-size:13px;word-break:break-all">${escapeHtml(token)}</code></p>`,
      footer: "If you didn't ask for this, ignore this email. Your password stays the same."
    })
  });
}

function passwordChanged(user) {
  return sendInBackground({
    to: user.email,
    subject: `Your ${SHOP_NAME} password was changed`,
    text: `Hi ${user.name || "there"},\n\nThe password for your ${SHOP_NAME} account was just changed.\n\nIf this wasn't you, reset your password right away: ${FRONTEND_URL}/auth.html`,
    html: layout({
      title: "Your password was changed",
      intro: `The password for <strong>${escapeHtml(user.email)}</strong> was just changed.`,
      button: { label: "Wasn't you? Reset it", url: `${FRONTEND_URL}/auth.html` },
      footer: "If you made this change, you don't need to do anything."
    })
  });
}

function orderConfirmation(order) {
  const ordersUrl = `${FRONTEND_URL}/profile-orders.html`;
  return sendInBackground({
    to: order.userEmail,
    subject: `Order confirmed: ${order.id}`,
    text: `Hi ${order.userName || "there"},\n\nThanks for your order ${order.id}!\n\n${orderText(order)}\n\nTrack it here: ${ordersUrl}`,
    html: layout({
      title: "Thanks for your order!",
      intro: `Order <strong>${escapeHtml(order.id)}</strong> is confirmed. We'll email you when its status changes.`,
      bodyHtml: orderTableHtml(order),
      button: { label: "View my orders", url: ordersUrl }
    })
  });
}

function orderStatus(order) {
  const status = String(order.status || "").toLowerCase();
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  const ordersUrl = `${FRONTEND_URL}/profile-orders.html`;
  return sendInBackground({
    to: order.userEmail,
    subject: `Order ${order.id}: ${label}`,
    text: `Hi ${order.userName || "there"},\n\nYour order ${order.id} is now: ${label}.\n${STATUS_TEXT[status] || ""}\n\n${orderText(order)}\n\n${ordersUrl}`,
    html: layout({
      title: `Your order is ${status}`,
      intro: `Order <strong>${escapeHtml(order.id)}</strong>: ${escapeHtml(STATUS_TEXT[status] || `status changed to ${label}.`)}`,
      bodyHtml: orderTableHtml(order),
      button: { label: "View my orders", url: ordersUrl }
    })
  });
}

function newOrderAlert(order) {
  if (!ORDER_NOTIFY_EMAIL) {
    return false;
  }
  return sendInBackground({
    to: ORDER_NOTIFY_EMAIL,
    subject: `New order ${order.id} - ${money(order.total)}`,
    text: `New order from ${order.userName} <${order.userEmail}>\n\n${orderText(order)}\n\nAdmin panel: ${FRONTEND_URL}/admin.html`,
    html: layout({
      title: "New order",
      intro: `<strong>${escapeHtml(order.userName)}</strong> (${escapeHtml(order.userEmail)}) placed order <strong>${escapeHtml(order.id)}</strong>.`,
      bodyHtml: orderTableHtml(order),
      button: { label: "Open admin panel", url: `${FRONTEND_URL}/admin.html` },
      footer: "You get this because ORDER_NOTIFY_EMAIL is set on the server."
    })
  });
}

// Sent and awaited, so the admin panel can show whether it worked.
function testEmail(to) {
  return send({
    to,
    subject: `${SHOP_NAME} test email`,
    text: `It works! Your ${SHOP_NAME} shop can send emails.\n\nSent at ${new Date().toISOString()}.`,
    html: layout({
      title: "It works!",
      intro: `Your ${escapeHtml(SHOP_NAME)} shop can send emails. Welcome emails, password resets and order updates will now be delivered.`,
      footer: `Sent at ${escapeHtml(new Date().toISOString())}.`
    })
  });
}

module.exports = {
  isConfigured,
  verify,
  status,
  welcome,
  passwordReset,
  passwordChanged,
  orderConfirmation,
  orderStatus,
  newOrderAlert,
  testEmail,
  FRONTEND_URL
};
