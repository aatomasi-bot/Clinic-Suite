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
        if (meta.filed) continue;   // already moved to the Medicum folder — only the search finds it
        const names = meta.attachments || [f.replace(/\.json$/, '.pdf')];
        const pdfs = names.filter(n => fs.existsSync(path.join(dir, n)))
          .map(n => ({ name: n, bytes: fs.readFileSync(path.join(dir, n)) }));
        yield { folder: 'Inbox', bodyText: '', ...meta, pdfs };
      }
    },
    // Emails about one file number (subject or attachment names) — like the live search
    async *findRelated(fileNumber, { known = async () => false } = {}) {
      if (!fs.existsSync(dir)) return;
      const re = new RegExp(`(^|\\D)${fileNumber}(\\D|$)`);
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const names = meta.attachments || [f.replace(/\.json$/, '.pdf')];
        if (!re.test(meta.subject || '') && !names.some(n => re.test(n))) continue;
        if (await known(meta.messageId)) continue;
        const pdfs = names.filter(n => fs.existsSync(path.join(dir, n))).map(n => ({ name: n, bytes: fs.readFileSync(path.join(dir, n)) }));
        yield { folder: 'Medicum', bodyText: '', ...meta, pdfs };
      }
    },
    async markHandled() {},
    async close() {},
  };
}

// Download each part in one piece (chunked downloads sometimes stopped after
// the first 64 KB chunk — 47,892 bytes — and big PDFs became unreadable).
const WHOLE = 64 * 1024 * 1024;
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

function textPart(node, type = 'text/plain') {
  if (!node) return null;
  if (node.part && node.type === type && node.disposition !== 'attachment') return { part: node.part, html: type === 'text/html' };
  for (const c of node.childNodes || []) { const p = textPart(c, type); if (p) return p; }
  if (node.type === type) return { part: node.part || '1', html: type === 'text/html' };
  return type === 'text/plain' ? textPart(node, 'text/html') : null;   // HTML-only emails (no-reply@)
}
const htmlToText = h => h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');

// wanted(email) → true for emails worth reading (from classifyEmail on headers)
export function imapSource(cfg, { wanted }) {
  const password = getSecret(SECRETS.yahooPassword);
  if (!password) throw new Error('No Yahoo app password in Keychain — see assistant/README.md, step "Connect the mailbox".');
  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: true,
    auth: { user: cfg.user, pass: password },
    logger: false,
  });
  // Yahoo sometimes drops the connection ("Socket timeout"); without a listener
  // that error crashed the whole run
  client.on('error', e => console.warn('  mail connection:', e.message));
  let connected = false;
  const open = async folder => {
    if (!connected) { await client.connect(); connected = true; }
    if (client.mailbox?.path !== folder) await client.mailboxOpen(folder);
  };
  // Headers + structure first (cheap); emails can then be filtered before any download.
  async function headers(folder, days) {
    await open(folder);
    const uids = await client.search({ since: new Date(Date.now() - days * 864e5) }, { uid: true });
    const metas = [];
    if (!uids.length) return metas;
    for await (const msg of client.fetch(uids, { uid: true, envelope: true, bodyStructure: true }, { uid: true })) {
      const from = msg.envelope.from?.[0];
      metas.push({
        uid: msg.uid, folder,
        messageId: msg.envelope.messageId || `uid-${msg.uid}`,
        from: from ? `${from.name || ''} <${from.address}>` : '',
        subject: msg.envelope.subject || '',
        date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : null,
        parts: pdfParts(msg.bodyStructure),
        text: textPart(msg.bodyStructure),
      });
    }
    return metas;
  }
  // download() uses BODY.PEEK — reading never marks the email as read
  async function full(m) {
    await open(m.folder);
    const pdfs = [];
    for (const p of m.parts) {
      const { content } = await client.download(String(m.uid), p.part, { uid: true, chunkSize: WHOLE });
      pdfs.push({ name: p.name, bytes: await readAll(content) });
    }
    let bodyText = '';
    if (m.text) {
      try {
        const { content } = await client.download(String(m.uid), m.text.part, { uid: true, maxBytes: 32000, chunkSize: WHOLE });
        const raw = (await readAll(content)).toString('utf8');
        bodyText = (m.text.html ? htmlToText(raw) : raw).slice(0, 8000);
      } catch {}
    }
    return { ...m, pdfs, bodyText };
  }
  return {
    name: `IMAP ${cfg.folder}`,
    async *emails() {
      for (const m of await headers(cfg.folder, cfg.lookbackDays)) {
        const email = { ...m, bodyText: '', pdfs: m.parts.map(p => ({ name: p.name })) };
        if (!wanted(email)) { yield { ...email, pdfs: [], skipped: true }; continue; }
        yield await full(m);
      }
    },
    // The other emails about one patient: same file number in the subject or an
    // attachment name, in the Inbox and the Medicum folder (already-filed emails too)
    async *findRelated(fileNumber, { known = async () => false } = {}) {
      const re = new RegExp(`(^|\\D)${fileNumber}(\\D|$)`);
      for (const folder of [cfg.folder, ...(cfg.relatedFolders || ['Medicum'])]) {
        let metas = [];
        try { metas = await headers(folder, cfg.relatedDays || 10); } catch { continue; }   // folder missing
        for (const m of metas) {
          if (!re.test(m.subject) && !m.parts.some(p => re.test(p.name))) continue;
          if (!wanted({ ...m, pdfs: m.parts.map(p => ({ name: p.name })) })) continue;
          if (await known(m.messageId)) continue;   // already read — nothing to download
          yield await full(m);
        }
      }
    },
    async markHandled(email) {
      if (connected && email.uid && cfg.flagHandled) {
        await open(email.folder || cfg.folder);
        await client.messageFlagsAdd(String(email.uid), ['\\Flagged'], { uid: true });
      }
    },
    async close() {
      try { await client.logout(); } catch {}
    },
  };
}
