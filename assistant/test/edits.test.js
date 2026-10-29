// Oct 29 2026: your edits are what Claude works on, and the names option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processAi } from '../ai-queue.js';
import { aiReply, checkReply } from '../lib/ai.js';
import { buildContext, cleanQuestion, parseBrain, brainSystem } from '../lib/brain.js';

const saved = 'Hello Julie,\n\nI have closed the file #98004.\n\nThank you!\n\nAbdul Rahim Akhtar';
const edited = 'Hello Julie,\n\nI have closed the file #98004. I will call the family Monday.\n\nThank you!\n\nAbdul Rahim Akhtar';

test('a rewrite works on the text you edited, not the saved draft, and remembers it', async () => {
  let sent = '';
  const run = async p => { sent = p; return 'Hello Julie,\n\nFile #98004 is closed; I will call the family Monday.\n\nThank you!\n\nAbdul Rahim Akhtar'; };
  const [u] = await processAi({ tasks: [{ id: 'a', is_test: true, status: 'reply_ready', reply_body: saved, details: { ai_request: { action: 'shorter', base: edited, at: 'x' } } }], run, realEmails: false });
  assert.match(sent, /call the family Monday/, 'Claude got your edit');
  assert.equal(u.details.ai_suggestion.base, edited, 'the suggestion says which text it was made from');
  assert.equal(u.details.ai_suggestion.action, 'shorter');
});

test('the first suggestion records the text it was made from (the page flags it once you edit)', async () => {
  const run = async () => saved;
  const [u] = await processAi({ tasks: [{ id: 'b', is_test: true, status: 'reply_ready', reply_body: saved, details: {} }], run, realEmails: false });
  assert.equal(u.details.ai_suggestion.base, saved);
});

test('names option: names stay, contact details still removed', async () => {
  let sent = '';
  const draft = 'Hello Julie,\n\nMr. Jean Tremblay (#35037) was seen today. His phone 514-555-0199.\n\nAbdul Rahim Akhtar';
  const run = async p => { sent = p; return 'Hello Julie,\n\nMr. Jean Tremblay (#35037) was seen today.\n\nAbdul Rahim Akhtar'; };
  const on = await aiReply({ run, action: 'shorter', draft, excerpt: 'Has Mr. Jean Tremblay been seen?', names: ['Jean Tremblay'], shareNames: true });
  assert.ok(sent.includes('Jean Tremblay') && !sent.includes('514-555-0199'));
  assert.ok(on.text, 'a reply with the name is accepted');
  await aiReply({ run, action: 'shorter', draft, excerpt: 'x', names: ['Jean Tremblay'] });
  assert.ok(!sent.includes('Tremblay'), 'default: names removed as before');
  assert.equal(checkReply('Hello Julie,\n\nMr. Jean Tremblay (#35037) seen.\n\nAbdul Rahim Akhtar', 'Hello Julie,\n#35037\nAbdul Rahim Akhtar').ok, false, 'default check still rejects names');
});

test('Dubbi with the names option: sees names, keeps the question as said, no streets', () => {
  const patients = [{ file_number: '35037', patient_name: 'Jean Tremblay', address: '12 rue X, Laval, QC', due_date: '2026-11-02' }];
  const ctx = buildContext({ patients, shareNames: true });
  assert.match(ctx, /#35037 \| Jean Tremblay \|/);
  assert.ok(!/rue X/.test(ctx));
  assert.ok(!/Tremblay/.test(buildContext({ patients })), 'default: no names');
  assert.equal(cleanQuestion('when is Trembley due? call 514-555-0199', patients, { shareNames: true }), 'when is Trembley due? call [phone]');
  assert.match(brainSystem({ shareNames: true }), /misheard/);
  const out = parseBrain('{"say":"#35037 (Jean Tremblay) is due Nov 2.","show":["35037"],"action":null}', ['35037'], { shareNames: true });
  assert.equal(out.say, '#35037 (Jean Tremblay) is due Nov 2.');
});
