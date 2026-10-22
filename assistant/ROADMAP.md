# Intake assistant — next steps (agreed 2026-10-20)

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
