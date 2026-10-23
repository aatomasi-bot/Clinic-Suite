// Where assignment emails come from.
//   test  → a local folder of FAKE PDFs + .json headers (make-fake-pdfs.js)
//   live  → the Yahoo mailbox over IMAP (read-only, plus a flag once handled)
// Both yield: { messageId, from, subject, date, folder, bodyText, pdfs: [{ name, bytes }], uid? }
// bodyText is a short snippet, used only to detect the language — never stored.
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
        const names = meta.attachments || [f.replace(/\.json$/, '.pdf')];
        const pdfs = names.filter(n => fs.existsSync(path.join(dir, n)))
          .map(n => ({ name: n, bytes: fs.readFileSync(path.join(dir, n)) }));
        yield { folder: 'Inbox', bodyText: '', ...meta, pdfs };
      }
    },
    async markHandled() {},
    async close() {},
  };
}

const IMAGE = /\.(jpe?g|png|heic|tiff?)$/i;
function pdfParts(node, out = []) {
  if (!node) return out;
  const name = node.dispositionParameters?.filename || node.parameters?.name || '';
  if (node.part && (node.type === 'application/pdf' || /\.pdf$/i.test(name))) out.push({ part: node.part, name: name || `attachment-${node.part}.pdf` });
  // A photo/scan of the form ("RM12345NewCPP.jpg") counts as a document too (typed by its name)
  else if (node.part && name && /^image\//i.test(node.type) && IMAGE.test(name)) out.push({ part: node.part, name });
  (node.childNodes || []).forEach(c => pdfParts(c, out));
  return out;
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

function textPart(node) {
  if (!node) return null;
  if (node.part && node.type === 'text/plain' && node.disposition !== 'attachment') return node.part;
  for (const c of node.childNodes || []) { const p = textPart(c); if (p) return p; }
  return node.type === 'text/plain' ? (node.part || '1') : null;
}

// wanted(email) → true for emails worth reading (from classifyEmail on headers)
export function imapSource(cfg, { wanted }) {
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
          text: textPart(msg.bodyStructure),
        });
      }
      for (const m of metas) {
        const email = { ...m, folder: cfg.folder, bodyText: '', pdfs: m.parts.map(p => ({ name: p.name })) };
        if (!wanted(email)) { yield { ...email, pdfs: [], skipped: true }; continue; }
        // download() uses BODY.PEEK — reading never marks the email as read
        const pdfs = [];
        for (const p of m.parts) {
          const { content } = await client.download(String(m.uid), p.part, { uid: true });
          pdfs.push({ name: p.name, bytes: await readAll(content) });
        }
        let bodyText = '';
        if (m.text) {
          try {
            const { content } = await client.download(String(m.uid), m.text, { uid: true, maxBytes: 4000 });
            bodyText = (await readAll(content)).toString('utf8').slice(0, 2000);
          } catch {}
        }
        yield { ...email, pdfs, bodyText };
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
