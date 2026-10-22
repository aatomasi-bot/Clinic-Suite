# Intake assistant — roadmap

**Done 2026-10-22:** Inbox folder, reply drafts + Send (EN/FR, gender-neutral "the file"),
prescription and close-file cards, outbox, move to Medicum after sending.

---

## Original notes (2026-10-20)

## Correction: where the emails arrive
Coordinator emails arrive in Yahoo **Inbox**, not Medicum. You move the
processed ones to the **Medicum** folder yourself. So the assistant must:
- watch `Inbox` (config.example.json now says `"folder": "Inbox"`)
- after you've handled an email, offer to **move it to Medicum** (with your OK)

## New feature: reply to coordinators (always asks you first)
The assistant drafts the reply. Nothing is sent until you tap **Send** in Approvals.
The greeting uses the coordinator's first name from the From: line
("Giulia Rodi <giuliar@medicum.ca>" → "Hello Giulia,").

| Email type | You do first, in VaPiq | Reply drafted after that |
|---|---|---|
| New patient (PDF) | Approve / add the patient | "Hello {name}, I confirm the receipt of this email." |
| New prescription for an existing patient | Apply the prescription to the file | "Hello {name}, I have added this prescription to his file." |
| Close file / Fermeture de dossier | Close (archive) the file | "Hello {name}, I have closed his file." |

Open questions to settle before building:
- "his file" → should it say "her file" for female patients, or "the file"?
- Should the reply be in French when the coordinator wrote in French?
- Sending needs Yahoo SMTP (same app password) — reply in the same thread (Re: subject).
- Status emails (close file, prescription) are currently *excluded* in `rules`;
  they become new card types: "Prescription for existing patient", "Close file".

## Before trusting the dose detection
Run 3–5 real assignment PDFs through medicum-parser.html on your Mac and
check the console line `[DOSE] … — <reason>`.

## Still open
- Signature line for replies (config.json → replies.signature)
- Scanned/faxed PDFs: OCR on the Mac instead of opening the Medicum Parser
- Other status emails (on hold, transfer, patient is back, update) — not handled yet
- Optional: AI-polished reply wording — only once an approved setup (BAA) is in place
