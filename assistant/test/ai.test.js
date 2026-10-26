// Reply suggestions: privacy clean-up, the privacy switch, and checks on what comes back.
// Claude is replaced by a scripted function — no network, no subscription use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, excerptOf, buildPrompt, checkReply } from '../lib/ai.js';
import { processAi } from '../ai-queue.js';

test('contact details are removed before anything goes to Claude', () => {
  const s = redact('Call his wife at 514-555-0199 or (438) 555 0100 ext 22, email jean.t@gmail.com, 1234 Boulevard Deguire, Apt. 3, Montreal H4N 1N4 — see https://x.ca/a');
  for (const bad of ['514-555-0199', '555 0100', 'jean.t@gmail.com', '1234 Boulevard Deguire', 'Apt. 3', 'H4N 1N4', 'https://x.ca'])
    assert.ok(!s.includes(bad), `${bad} must be removed`);
  for (const tag of ['[phone]', '[email]', '[address]', '[postal code]', '[link]', '[unit]']) assert.ok(s.includes(tag), tag);
  assert.equal(redact('45, rue Saint-Denis'), '[address]');
  assert.equal(redact('Next injection October 29th 2026, file #35335'), 'Next injection October 29th 2026, file #35335', 'dates and file numbers stay');
});

test('only the coordinator\'s own message is used (no signature or disclaimer)', () => {
  const body = 'Hello Abdul,\nPlease find the documents for #35037.\nThank you\nKavya Shetty\nT. 1 450 555 1234\nkavyas@medicum.ca\nLe présent message électronique est confidentiel.';
  const ex = excerptOf(body);
  assert.match(ex, /Please find the documents for #35037/);
  assert.ok(!/Kavya Shetty|450 555 1234|kavyas@|confidentiel/.test(ex));
});

test('suggestions that lose the file number or signature, or add contact details, are rejected', () => {
  const draft = 'Hello Julie,\n\nI have closed the file #98004.\n\nThank you!\n\nAbdul Rahim Akhtar';
  assert.ok(checkReply('Hello Julie,\n\nThe file #98004 is now closed.\n\nThank you!\n\nAbdul Rahim Akhtar', draft).ok);
  assert.equal(checkReply('Hello Julie,\n\nDone.\n\nThank you!\n\nAbdul Rahim Akhtar', draft).ok, false, 'file number lost');
  assert.equal(checkReply('Hello Julie,\n\nFile #98004 closed. Call me at 514-555-0000.\n\nAbdul Rahim Akhtar', draft).ok, false, 'phone added');
  assert.equal(checkReply('Hello Julie,\n\nFile #98004 closed.', draft).ok, false, 'signature lost');
  assert.match(buildPrompt({ action: 'custom', instruction: 'tell her I will call Monday', draft, excerpt: 'x' }), /tell her I will call Monday/);
});

test('privacy switch: real cards are never sent to Claude until realEmails is on', async () => {
  const calls = [];
  const run = async p => { calls.push(p); return 'Hello Julie,\n\nThe file #98004 is now closed.\n\nThank you!\n\nAbdul Rahim Akhtar'; };
  const draft = 'Hello Julie,\n\nI have closed the file #98004.\n\nThank you!\n\nAbdul Rahim Akhtar';
  const tasks = [
    { id: 'real', is_test: false, status: 'reply_ready', reply_body: draft, details: { excerpt: 'please close' } },
    { id: 'test', is_test: true, status: 'reply_ready', reply_body: draft, details: { excerpt: 'please close' } },
    { id: 'ask', is_test: true, status: 'todo', reply_body: draft, details: { ai_request: { action: 'french', at: 'now' } } },
  ];
  const off = await processAi({ tasks, run, realEmails: false });
  assert.deepEqual(off.map(u => u.id), ['test', 'ask'], 'the real card was skipped');
  const realAsk = await processAi({ tasks: [{ ...tasks[0], details: { ai_request: { action: 'shorter', at: 'now' } } }], run, realEmails: false });
  assert.match(realAsk[0].details.ai_error, /privacy officer/, 'a request on a real card is answered with why, not sent');
  assert.equal(calls.length, 2, 'Claude was called for the two test cards only');
  assert.ok(off[0].details.ai_suggestion.text.includes('#98004'));
  assert.ok(off[1].details.ai_request.done, 'request marked done');
  const on = await processAi({ tasks: [tasks[0]], run, realEmails: true });
  assert.deepEqual(on.map(u => u.id), ['real']);
  const again = await processAi({ tasks: [{ ...tasks[1], details: off[0].details }], run, realEmails: false });
  assert.equal(again.length, 0, 'one suggestion per card, not every 30 seconds');
});
