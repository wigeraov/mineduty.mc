const config = require('./config');
let transport = null;
const configured = () => !!config.smtp.host;
async function sendMail({ to, subject, text }) {
  if (!configured()) { console.log(`\n[mail:dev] SMTP не настроен. Письмо для ${to}\n  Тема: ${subject}\n  ${text}\n`); return false; }
  if (!transport) transport = require('nodemailer').createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined });
  await transport.sendMail({ from: config.smtp.from, to, subject, text });
  return true;
}
module.exports = { sendMail, configured };
