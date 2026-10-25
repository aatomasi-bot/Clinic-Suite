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
(sender domains, excluded senders, subject patterns). Medicum sends the forms from **no-reply@medicum.ca** ("New Appointment"): those emails are read and paired with the coordinator's note, never replied to. The patient card is filled from **Enrollment_Form_Auto_Generated_#####.pdf** first (a text PDF with every field; the assignment form is usually a scan).

## Dose detection

The selected dose is found by **position on the page**. The parser locates the four
options, then looks for a ticked checkbox, an X/✓, a filled box, an underline or a
bold option that singles out exactly one of them. If nothing does, or the marks
disagree, the dose is left **blank** and the card asks you to check the PDF. It
never guesses.

**Scanned forms** are read by your Mac's built-in text recognition (Vision, the
Live Text engine — on this Mac only, nothing is sent anywhere). The helper
(`ocr/ocr.swift`) is compiled automatically the first time (needs the Xcode Command
Line Tools). On Medicum's assignment form the chosen dose line has the months filled
in ("22.5 mg, (3 months) for a period of _18_ months"): total doses = months ÷ the
dose's months (7.5→1, 22.5→3, 30→4, 45→6), unless "Number of injections" is filled
in. If the scan and the enrollment form disagree on the dose, the card warns you.

**Where the card's data comes from** (best first): `Enrollment_Form_Auto_Generated_….pdf`
(text, every field), then the assignment form (`RA35037.pdf`, `JS35335New.pdf` — initials +
file number), read by text recognition when scanned. **FAX_…, fax-sip…, RX…, Nurse_Report…**
files are copies and are never read for patient data. If a card was made from a weaker
source and a better form arrives, the waiting card is rebuilt.

**Related emails.** One patient's documents usually come in separate emails (coordinator
note, no-reply@ "New Appointment" with the forms, reports@ copies). Whenever an item is
missing a form, the assistant searches the Inbox **and the Medicum folder** (last 10 days)
for emails with that file number in the subject or an attachment name, and reads them.

**Coordinator writing from reports@.** When a reports@ email is signed by a coordinator
(name above "Coordonnatrice…/Coordinator", address `name@medicum.ca`), the reply goes to
her, with reports@ in copy. The reply's language follows her message, not the bilingual
signature or disclaimer.

**From the coordinator's email** ("…assigned for the following date: October 29th 2026" or "Next injection scheduled for: 9th March 2027"
(
(Bone scan … need the injection after)" / "…pour la date suivante : 21 septembre 2026"):
the **due date** comes from that sentence (it wins over the form; the card says so when
they differ) and the reason in brackets goes into **Special Instructions** as
"Coordinator: …". "Please have the patient sign the enrollment form" adds
"Signature required!". When that email arrives after the forms, the waiting card is
updated (never a patient already added to VaPiq).

## Notes to Medicum from VaPiq

On a patient card (open it), **✉️ Medicum** writes to reports@medicum.ca about that
patient; the **✉️** button next to the search bar turns on Select mode to write about
several patients in one email. Pick reasons (✏️ Other lets you type one), add details,
check the preview, tap Send. Every email lists each patient's name and file number.
VaPiq saves it as an approved "note to Medicum" (`email_tasks.kind = medicum_note`,
`supabase/2026-10-25_medicum_notes.sql`); your Mac sends it as a new email from
abdulmedicum@yahoo.com within ~2 minutes (live mode), and it appears in Dubbi's History.

## Dubbi — ask by typing or voice

Tap the round button in the Dubbi app and ask: "What's new?", "Anything overdue?",
"Who needs an appointment?", "Who do I confirm?", "Today's visits", "Replies to
send", "Missing documents", a file number, or "Find <name>" (English or French).

- **Everything runs on your phone.** No AI service is used and nothing is sent
  anywhere new: Dubbi follows fixed rules over the same data the page already shows.
- **It never acts on its own.** Say or type "close file 32604", "send the reply for 35290",
  "prescription applied 30001", "ask for the documents for 34734" or "add 34734": Dubbi
  says what it will do and waits for **Confirm** (or "yes"). Then it presses that card's
  own button, so every check the card does still applies.
- Answers are read aloud with the iPhone's own voices (on the phone).
- The **microphone is off by default** (Dubbi → ⚙︎). Speech goes through Apple's
  dictation, like the keyboard mic, so turn it on only once your privacy officer
  agrees. Typing always works.
