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

// The email(s) a task replies to: all paired emails, or just the original.
const emailsOf = task => (task.related_emails && task.related_emails.length) ? task.related_emails
  : [{ message_id: task.email_message_id, folder: task.email_folder }];

export function replySubject(subject) {
  const s = String(subject || '').trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

function message(task, from) {
  return {
    from,
    to: task.to_name ? { name: task.to_name, address: task.to_address } : task.to_address,
    ...(task.cc_addresses && task.cc_addresses.length ? { cc: task.cc_addresses } : {}),
    // A note you write to Medicum from VaPiq is a new email (no "Re:", not threaded)
    subject: task.kind === 'medicum_note' ? String(task.email_subject || 'Update') : replySubject(task.email_subject),
    text: task.reply_body,
    ...(task.email_message_id && task.kind !== 'medicum_note' ? { inReplyTo: task.email_message_id, references: [task.email_message_id] } : {}),
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
    async moveOriginal(task, toFolder) { moves.push({ id: task.id, toFolder, emails: emailsOf(task).length }); return true; },
    unflags: [],
    async unflag(task) { this.unflags.push(task.id); return true; },
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
      imap.on('error', e => console.warn('  mail connection:', e.message));
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
    // Finds each original (coordinator + reports@) by Message-ID — UIDs can
    // change — and moves it to the Medicum folder.
    async moveOriginal(task, toFolder) {
      const c = await imapClient();
      let moved = 0;
      for (const e of emailsOf(task)) {
        if (!e.message_id || !e.folder || e.folder === toFolder) continue;
        const lock = await c.getMailboxLock(e.folder);
        try {
          const uids = await c.search({ header: { 'message-id': e.message_id } }, { uid: true });
          if (uids.length) { await c.messageMove(uids, toFolder, { uid: true }); moved++; }
        } finally { lock.release(); }
      }
      return moved > 0;
    },
    // "Leave it": take the assistant's ★ off the email(s) — they stay where they are, unread
    async unflag(task) {
      const c = await imapClient();
      let done = 0;
      for (const e of emailsOf(task)) {
        if (!e.message_id || !e.folder) continue;
        const lock = await c.getMailboxLock(e.folder);
        try {
          const uids = await c.search({ header: { 'message-id': e.message_id } }, { uid: true });
          if (uids.length) { await c.messageFlagsRemove(uids, ['\\Flagged'], { uid: true }); done++; }
        } finally { lock.release(); }
      }
      return done > 0;
    },
    async close() { try { await imap?.logout(); } catch {} smtp.close(); },
  };
}
