// Where assignment emails come from.
//   test  → a local folder of FAKE PDFs + .json headers (make-fake-pdfs.js)
//   live  → the Yahoo mailbox over IMAP (read-only, plus a flag once handled)
// Both yield: { messageId, from, subject, date, pdfs: [{ name, bytes }], uid? }
import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { getSecret, SECRETS } from './keychain.js';

export function testFolderSource(dir) {
  return {
    name: `test folder (${path.basename(dir)})`,
    async *emails() {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const pdfPath = path.join(dir, f.replace(/\.json$/, '.pdf'));
        const pdfs = fs.existsSync(pdfPath) ? [{ name: path.basename(pdfPath), bytes: fs.readFileSync(pdfPath) }] : [];
        yield { ...meta, pdfs };
      }
    },
    async markHandled() {},
    async close() {},
  };
}

function pdfParts(node, out = []) {
  if (!node) return out;
  const name = node.dispositionParameters?.filename || node.parameters?.name || '';
  if (node.part && (node.type === 'application/pdf' || /\.pdf$/i.test(name))) out.push({ part: node.part, name: name || `attachment-${node.part}.pdf` });
  (node.childNodes || []).forEach(c => pdfParts(c, out));
  return out;
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

export function imapSource(cfg, { isAssignmentHeaders }) {
  const password = getSecret(SECRETS.yahooPassword);
  if (!password) throw new Error('No Yahoo app password in Keychain — see assistant/README.md, step "Connect the mailbox".');
  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: true,
    auth: { user: cfg.user, pass: password },
    logger: false,
  });
  let opened = false;
  return {
    name: `IMAP ${cfg.folder}`,
    async *emails() {
      await client.connect();
      await client.mailboxOpen(cfg.folder);
      opened = true;
      const since = new Date(Date.now() - cfg.lookbackDays * 864e5);
      const uids = await client.search({ since }, { uid: true });
      if (!uids.length) return;
      // Headers + structure first; bodies only for emails that look like assignments.
      const metas = [];
      for await (const msg of client.fetch(uids, { uid: true, envelope: true, bodyStructure: true }, { uid: true })) {
        const from = msg.envelope.from?.[0];
        metas.push({
          uid: msg.uid,
          messageId: msg.envelope.messageId || `uid-${msg.uid}`,
          from: from ? `${from.name || ''} <${from.address}>` : '',
          subject: msg.envelope.subject || '',
          date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : null,
          parts: pdfParts(msg.bodyStructure),
        });
      }
      for (const m of metas) {
        const email = { ...m, pdfs: m.parts.map(p => ({ name: p.name })) };
        if (!isAssignmentHeaders(email)) { yield { ...email, pdfs: [], skipped: true }; continue; }
        const pdfs = [];
        for (const p of m.parts) {
          const { content } = await client.download(String(m.uid), p.part, { uid: true });  // BODY.PEEK — doesn't mark read
          pdfs.push({ name: p.name, bytes: await readAll(content) });
        }
        yield { ...email, pdfs };
      }
    },
    async markHandled(email) {
      if (opened && email.uid && cfg.flagHandled) {
        await client.messageFlagsAdd(String(email.uid), ['\\Flagged'], { uid: true });
      }
    },
    async close() {
      try { await client.logout(); } catch {}
    },
  };
}
