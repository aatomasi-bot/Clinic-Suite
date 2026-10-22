# VaPiq intake assistant

Reads coordinator emails in your Yahoo **Inbox**, prepares the work in the
**Approvals** page, and replies to the coordinator once you've done it. You
approve every step.

| Email from a coordinator | Card in Approvals | After you act | Reply (you tap Send) |
|---|---|---|---|
| New patient (PDF, file # not in VaPiq) | patient form, pre-filled | **Add to VaPiq** | "I confirm the receipt of this email…" |
| Prescription (PDF, file # in VaPiq) | current dose vs prescription | apply it in VaPiq → **Applied** | "…I have added this prescription to the file." |
| Close file / Fermeture de dossier | patient + status | **Close file in VaPiq** (= Archive) | "…I have closed the file." |

Replies greet the coordinator by first name, use their language (French or English),
are fully editable, and are sent by your Mac within ~2 minutes of you tapping
**Send**. They go in the same email thread, and the original email is then moved from Inbox to Medicum.

What it will **never** do: send anything you didn't approve, write to
anyone outside medicum.ca, delete email, change `patients` without your tap, or
put patient details in a notification.

## Setup (once)

1. **Database**: in Supabase → SQL Editor, run each file in `supabase/` once, in date order:
   `2026-10-20_intake_assistant.sql`, `2026-10-22_coordinator_replies.sql`,
   `2026-10-22_lock_pins_reminders.sql`, `2026-10-22_pairing_safety_net.sql`, `2026-10-23_remove_dubbi_ai.sql`.
2. **Install**: in Terminal:
   ```bash
   cd ~/Downloads/Code/Clinic-Suite/assistant && npm install
   ```
3. **Sign in** as yourself. Your password is typed in Terminal and never stored; only a session token goes in your Keychain:
   ```bash
   npm run login
   ```
4. **Phone notifications**: create the push keys, then commit `approvals/push-config.js`:
   ```bash
   npm run setup-push
   ```
5. **iPhone**: in Safari open `https://aatomasi-bot.github.io/Clinic-Suite/approvals/`,
   tap Share → *Add to Home Screen*, open **Approvals** from the Home Screen, then tap 🔔 *Notify me*.
6. **Your signature**: create `config.json` (stays on your Mac) with the closing line for replies:
   ```json
   { "replies": { "signature": "Your Name, RN" } }
   ```
7. **Run every 2 minutes + 7:00 AM summary** in the background:
   ```bash
   ./install-launchd.sh
   ```
   (`./install-launchd.sh remove` stops it. The log is in `state/intake.log`.)

## Test mode (the default)

`config.example.json` has `"mode": "test"`: the assistant reads the FAKE emails in
`test-inbox/` (make them with `npm run fake-pdfs`). The cards it creates are marked
**TEST**: approving or closing never changes VaPiq, and replies are never sent.
Instead each one is saved as an `.eml` file in `state/outbox-test/` (double-click to open it in Mail).

- `npm run intake:offline`: no network, fake patients from `test/fixtures/`.
- `npm test`: parser, dose detection, duplicate rule and full pipeline.

## Going live: only once the mailbox is approved for patient data

Yahoo is not covered by a BAA. Switch to live only after your privacy officer
approves it, or after assignments move to an approved mailbox.

1. In Yahoo → Account security, create an **app password**. Store it in your
   Keychain yourself (Terminal will prompt for it):
   ```bash
   security add-generic-password -s vapiq-assistant-yahoo -a vapiq-assistant -w
   ```
2. Create `config.json` (not committed). Settings in it override `config.example.json`:
   ```json
   { "mode": "live", "liveConfirmed": true, "imap": { "user": "you@yahoo.com" } }
   ```

Live mode reads the `Inbox` for the last 7 days and opens attachments
without marking emails as read. Each handled email is starred (`\Flagged`). Once
its reply is sent, it is moved to `Medicum`. Replies go out through Yahoo SMTP with the
same app password. After the first live reply, check Yahoo's **Sent** folder: if
the reply isn't there, set `"replies": { "saveToSent": true }` in `config.json`. Which emails count as assignments is set in `rules`
(sender domains, excluded senders, subject patterns).

## Dose detection

The selected dose is found by **position on the page**. The parser locates the four
options, then looks for a ticked checkbox, an X/✓, a filled box, an underline or a
bold option that singles out exactly one of them. If nothing does, or the marks
disagree, the dose is left **blank** and the card asks you to check the PDF. It
never guesses. Scanned/faxed PDFs have no text layer; their card says to open the
PDF in the Medicum Parser (OCR).

## Dubbi — ask by typing or voice

Tap the round button in the Dubbi app and ask: "What's new?", "Anything overdue?",
"Who needs an appointment?", "Who do I confirm?", "Today's visits", "Replies to
send", "Missing documents", a file number, or "Find <name>" (English or French).

- **Everything runs on your phone.** No AI service is used and nothing is sent
  anywhere new: Dubbi follows fixed rules over the same data the page already shows.
- **It never acts.** It answers and opens the right card; you do the action there.
- Answers are read aloud with the iPhone's own voices (on the phone).
- The **microphone is off by default** (Dubbi → ⚙︎). Speech goes through Apple's
  dictation, like the keyboard mic, so turn it on only once your privacy officer
  agrees. Typing always works.
