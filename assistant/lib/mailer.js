// Sends the replies you approved, then files the original email.
//   liveMailer — Yahoo SMTP (same app password as IMAP), reply in the same
//                thread; then moves the original Inbox → Medicum over IMAP.
//   testMailer — never sends: writes each reply as an .eml file you can open in
//                Mail, and logs the move it would have made.
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { getSecret, SECRETS } from './keychain.js';

export function replySubject(subject) {
  const s = String(subject || '').trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

function message(task, from) {
  return {
    from,
    to: task.to_name ? { name: task.to_name, address: task.to_address } : task.to_address,
    subject: replySubject(task.email_subject),
    text: task.reply_body,
    ...(task.email_message_id ? { inReplyTo: task.email_message_id, references: [task.email_message_id] } : {}),
  };
}

export function testMailer(outDir) {
  const moves = [];
  return {
    kind: 'test',
    moves,
    async send(task) {
      fs.mkdirSync(outDir, { recursive: true });
      const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
      const info = await t.sendMail(message(task, 'VaPiq test <test@localhost>'));
      const file = path.join(outDir, `${task.id}.eml`);
      fs.writeFileSync(file, info.message);
      return { file };
    },
    async moveOriginal(task, toFolder) { moves.push({ id: task.id, toFolder }); return true; },
    async close() {},
  };
}

export function liveMailer(imapCfg, replyCfg) {
  const pass = getSecret(SECRETS.yahooPassword);
  if (!pass) throw new Error('No Yahoo app password in Keychain — see README, "Going live".');
  const smtp = nodemailer.createTransport({
    host: replyCfg.smtpHost, port: replyCfg.smtpPort, secure: true,
    auth: { user: imapCfg.user, pass },
  });
  let imap = null;
  const imapClient = async () => {
    if (!imap) {
      imap = new ImapFlow({ host: imapCfg.host, port: imapCfg.port, secure: true, auth: { user: imapCfg.user, pass }, logger: false });
      await imap.connect();
    }
    return imap;
  };
  return {
    kind: 'live',
    async send(task) {
      const msg = message(task, imapCfg.user);
      const info = await smtp.sendMail(msg);
      if (replyCfg.saveToSent) {
        const raw = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({ ...msg, messageId: info.messageId });
        await (await imapClient()).append('Sent', raw.message, ['\\Seen']);
      }
      return { messageId: info.messageId };
    },
    // Finds the original by Message-ID (UIDs can change) and moves it.
    async moveOriginal(task, toFolder) {
      if (!task.email_message_id || !task.email_folder || task.email_folder === toFolder) return false;
      const c = await imapClient();
      const lock = await c.getMailboxLock(task.email_folder);
      try {
        const uids = await c.search({ header: { 'message-id': task.email_message_id } }, { uid: true });
        if (!uids.length) return false;
        await c.messageMove(uids, toFolder, { uid: true });
        return true;
      } finally { lock.release(); }
    },
    async close() { try { await imap?.logout(); } catch {} smtp.close(); },
  };
}
