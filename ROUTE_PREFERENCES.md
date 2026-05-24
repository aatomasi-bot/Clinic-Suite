# VaPiq Route Preferences — Abdul's Circuit Rules
*Living document. Updated as new route comparisons are shared.*
*Last updated: May 24, 2026*
*Paste this file at the start of any Claude session to restore route context.*

---

## START POINTS

| Day | Postal Code | Area | Notes |
|---|---|---|---|
| Saturday | H4N 1N4 | Saint-Laurent | Unless South Shore patients → start there |
| Mon–Fri | H4J 1T2 | Cartierville / Ahuntsic | Unless South Shore patients → start there |
| Any day | User input | Override available | Manual start point change in scheduler UI |

---

## WORKING DAYS

| Day | Circuit | Cap | Notes |
|---|---|---|---|
| Tuesday | Montreal A | 10–15 | |
| Wednesday | Montreal A | 10–15 | |
| Thursday | Montreal A | 10–15 | |
| Friday | Laval / North Shore B | 10–12 hard cap | Never cluster |
| Saturday | Montreal A | 10–15 | Start H4N |
| Monday | Off — merge to Tue–Sat | — | Within ±3 day window |
| Sunday | Off — merge to Tue–Sat | — | Within ±3 day window |

---

## MONTREAL CIRCUIT A — Correct Step Order (from H4J start)

**Learned from: 10 June 2026 comparison (Claude vs preferred)**

The correct arc from H4J (Cartierville) is:
**North start → sweep south → South Shore tuck → return NE → end far east**

```
Home: H4J 1T2 (Cartierville)
  ↓
Step 1 — Near home / Ahuntsic area        H4J, H3L, H3M, H3N, H4K, H4N
  ↓
Step 2 — NDG / Côte-St-Luc / CSL          H3V–H3Z, H4A, H4B, H4V, H4W
  ↓
Step 3 — SW descent: Verdun / Lachine     H8, H3E, H3H, H3J, H4G, H4H
  ↓
Step 4 — South Shore tuck                 J3, J4, J5 (La Prairie, Longueuil, Brossard)
          (visited on southward arc — NOT first stop)
  ↓
Step 5 — Return: Plateau / Rosemont       H2, H1V, H1W, H1X, H1Y, H1Z, H2H–H2Z
  ↓
Step 6 — Far East (last stop)             H1A–H1N (Anjou, Saint-Léonard, PTX, RDP)
  ↓
Step 7 — NE Apex if applicable            J5Y, J6A (Repentigny / Charlemagne)
```

### ⚠ Key corrections vs. original algorithm

| Rule | Old (wrong) | New (correct) | Source |
|---|---|---|---|
| South Shore | Step 0 — always FIRST | Step 4 — southward arc middle | 10 Jun comparison |
| H4J/Ahuntsic area | Step 6 — last/return | Step 1 — FIRST (near home) | 10 Jun comparison |
| Lachine/Verdun (H8) | Step 1 — first | Step 3 — descent phase | 10 Jun comparison |
| Anjou/Saint-Léonard (H1) | Step 4 — middle | Step 6 — LAST | 10 Jun comparison |
| NDG/CSL | Step 2 | Step 2 — same ✓ | confirmed correct |

### Confirmed correct ordering
From the 10 June comparison, this sub-sequence was correct:
```
Côte-St-Luc (H3X) → La Prairie South Shore → NDG (H4A) → Plateau (H2J)
→ Rosemont (H2G) → far east
```

---

## LAVAL / NORTH SHORE CIRCUIT B — Step Order (Friday, H4J start)

*Not yet compared against a preferred route. Rules based on original specification.*

```
Home: H4J 1T2 → cross Laval bridges
  ↓
Step 1 — East Laval / river bank          H7A, H7B, H7C, H7E, H7G (Laval-des-Rapides, Pont-Viau)
  ↓
Step 2 — Terrebonne / Mascouche ring      J6W, J6X, J7K
  ↓
Step 3 — West across A-640               J7C (Rosemère), J7E (Lorraine), J7G (Blainville), J7H
  ↓
Step 4 — NW apex                          J7P (Saint-Eustache), J7R, J7V, J7X (Deux-Montagnes)
  ↓
Step 5 — West Island return hook          H8S, H9A–H9X (Pierrefonds, Kirkland, Beaconsfield)
```

### Special Laval rules
- **Terrebonne near Repentigny** (J6Y, J6Z) → moves to Montreal Circuit Step 7 (NE apex)
- **Terrebonne west** (J6W, J6X) → stays on Laval circuit Step 2
- **West Island due Monday** → prior Friday (Laval return) OR next Wed/Thu
- **Mixed circuit** (Laval + Montreal same day): only when ≥3 MTL + <7 total + 3–5 river bank Laval (H7A/B/C/E/G)

---

## SATURDAY CIRCUIT — Special Rules

*Saturday starts H4N 1N4 (Saint-Laurent). South Shore position TBC.*

- H4N is further south than H4J → South Shore may still be an early stop on Saturday
- **NEEDS CONFIRMATION** — share a Saturday route comparison to lock this in

---

## SOUTH SHORE — Detailed Rules

**Confirmed:** South Shore is NOT always first on Montreal days.

| Situation | South Shore position | Reasoning |
|---|---|---|
| Monday–Friday (H4J start) | Step 4 — southward arc middle | Route descends south naturally; visit SS on the way through |
| Saturday (H4N start) | **TBC** — needs comparison | H4N is closer to south; may be earlier |
| Saturday SS exists | First stop | User stated: "If South Shore patients, that is my start point" on Saturday |

**⚠ Conflict to resolve:** Original spec says "South Shore = start point" but the 10 Jun route shows it in the middle. User clarification needed: does "start point" apply only on Saturday?

---

## CLUSTER MODE

- **Auto-detect**: 75%+ of patients in same FSA2 prefix → cluster detected
- **Effect**: cap extended from 15 → 18 on Montreal days only
- **Friday**: NEVER cluster (hard cap 12)
- **Manual override**: ⊞ Cluster button on any Montreal day header

---

## CAPACITY RULES

| Day | Normal cap | Cluster cap |
|---|---|---|
| Friday | 12 (hard) | 12 (no cluster) |
| All other | 15 | 18 |

---

## OPTIMIZER — What's Built in scheduler.html

The scheduler has a **🧠 Optimize 2 Wks** button that:
1. Classifies patients by FSA → circuit + step
2. Plans 14 days respecting caps and ±3 day windows
3. Sorts each day by circuit step order
4. Stores plan in sessionStorage (survives navigation, clears on tab close)

**Current FSA table status**: Uses original step order (pre-10-Jun corrections).
**Needs update**: Once 2–3 more route comparisons confirm the step corrections above.

---

## ROUTE COMPARISONS LOG

| Date | Day | What was learned | Applied to scheduler? |
|---|---|---|---|
| May 24, 2026 | Wed Jun 10, 2026 | South Shore middle not first; H4J area first; far east last; Lachine is step 3 not 1 | ❌ Pending 2 more confirmations |

---

## PENDING CONFIRMATIONS NEEDED

Before updating scheduler FSA table, need examples of:

1. **Another Montreal day with South Shore** — confirm South Shore is always middle (not just Jun 10)
2. **A Saturday route** — confirm South Shore position from H4N start
3. **A route with Repentigny/NE apex** — confirm far-east endpoint behavior
4. **A Friday (Laval) route** — compare against Laval circuit step order

---

## HOW TO USE THIS FILE

**At the start of a new Claude session:**
1. Open this file from GitHub
2. Paste its contents into Claude with the message:
   *"Here are my VaPiq route preferences — please read and remember for this session"*
3. Claude will restore full context instantly

**When sharing a new route comparison:**
- Share both maps (your preferred + Claude's output)
- Claude will update the comparison log and identify new rules
- Once a rule is confirmed 2–3 times, it gets applied to scheduler.html FSA table

---

*File maintained by Claude. Part of VaPiq Clinical Suite.*
*GitHub: aatomasi-bot.github.io/Clinic-Suite/*
