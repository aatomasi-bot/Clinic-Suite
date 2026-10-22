# VaPiq intake assistant

Watches the **Medicum** mailbox for patient-assignment PDFs, checks VaPiq, and
asks you before anything is added.

```
Medicum email (coordinators @medicum.ca, reports@medicum.ca) + PDF
   → parse PDF with js/medicum-parse.js (same parser as medicum-parser.html)
   → file number already in VaPiq?  yes → "Already in VaPiq" card — nothing written
                                    no  → "To review" card + notification
   → you tap "Add to VaPiq" in approvals/ → patients row + audit_log entry
```

What it will **never** do: send email, delete anything, write to `patients`
without your approval, or put patient details in a notification.

## Setup (once)

1. **Database**: in Supabase → SQL Editor, run `supabase/2026-10-20_intake_assistant.sql`.
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
6. **Run every 10 minutes** in the background:
   ```bash
   ./install-launchd.sh
   ```
   (`./install-launchd.sh remove` stops it. The log is in `state/intake.log`.)

## Test mode (the default)

`config.example.json` has `"mode": "test"`: the assistant reads the FAKE PDFs in
`test-inbox/` (make them with `npm run fake-pdfs`). The cards it creates are marked
**TEST**, and approving one never writes to `patients`.

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

Live mode reads the `Medicum` folder for the last 7 days and opens attachments
without marking emails as read. Each handled email is starred (`\Flagged`) and
stays in `Medicum`. Which emails count as assignments is set in `rules`
(sender domains, excluded senders, subject patterns).

## Dose detection

The selected dose is found by **position on the page**. The parser locates the four
options, then looks for a ticked checkbox, an X/✓, a filled box, an underline or a
bold option that singles out exactly one of them. If nothing does, or the marks
disagree, the dose is left **blank** and the card asks you to check the PDF. It
never guesses. Scanned/faxed PDFs have no text layer; their card says to open the
PDF in the Medicum Parser (OCR).
