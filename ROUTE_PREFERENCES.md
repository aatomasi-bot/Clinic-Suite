# ROUTE_PREFERENCES.md — VaPiq Clinical Suite
*Living document. Paste this at the start of every new Claude session to restore context.*

---

## HOME BASE

**H4N 1N4 — Cartierville / Saint-Laurent, Montréal**
Home is ALWAYS the departure point. It is never counted as a stop.

> ⚠️ Previous session errors: Claude had assumed H4J 1T2, then H8S (Lachine) — both WRONG. Confirmed home is H4N 1N4.

---

## SPECIAL TRIGGER RULE — 32 Rue Vermette

> **When 32 Rue Vermette, Saint-Eustache is on the plan → it is always STOP #1.**
> Home still departs first, but Vermette is visited before any other patient stop.
> The rest of the route then continues in the normal NW → NE horseshoe arc.

**Confirmed order with Vermette present (May 25, 2026):**
`Home → Vermette → Guindon → Rang du Domaine (NW apex) → Damien-Cyr → Mascouche (NE apex) → Thomas Lapointe → Lévesque Est → 15e Rue → Coughtry`

---

## LAVAL / NORTH CIRCUIT — Step Order (from H4N)

Shape: **clockwise horseshoe** — start local, sweep NW to far apex, arc NE to far apex, return local.

| Step | Zone | Example addresses | Notes |
|------|------|-------------------|-------|
| Special | Saint-Eustache | 32 Rue Vermette | **Always first if present** |
| 1 | Local / St-Laurent | Coughtry H4L | Closest to home — visited LAST when no Vermette; first after Vermette trigger |
| 2 | West Laval entry | 15e Rue H7N | Enter Laval close to H4N |
| 3 | East Laval | Lévesque Est H7G | Sweep east in Laval |
| 4 | NW Laval | Damien-Cyr H7L | Swing northwest through Laval |
| 5 | Saint-Eustache | Vermette J7P, Guindon J7R | NW cluster |
| 6 | Far NW apex | Rang du Domaine J0N / Deux-Montagnes | **Furthest NW point** |
| 7 | NE arc | Terrebonne J6W | Swing northeast |
| 8 | Far NE apex | Mascouche J7K | **Furthest NE point** |

**Without Vermette:** Home → local (Coughtry) → W Laval → E Laval → Terrebonne → Mascouche (NE apex) → NW Laval → Saint-Eustache → far NW apex (end)

**With Vermette:** Home → Vermette (first!) → Saint-Eustache cluster → far NW apex → NW Laval → Mascouche (NE apex) → Terrebonne → E Laval → W Laval → Coughtry (end)

---

## MONTREAL CIRCUIT — Step Order (from H4N)

Shape: **SW-to-NE arc** ending in north Montreal.

| Step | FSA(s) | Neighbourhood |
|------|--------|---------------|
| 1 | H8S, H8R | Lachine |
| 2 | H8N, H8P | LaSalle |
| 3 | H3E | Nun's Island / Île-des-Sœurs |
| 4 | H4C, H4E | St-Henri / LaSalle east |
| 5 | H3W | NDG / Queen Mary |
| 6 | H3T | Côte-Ste-Catherine |
| 7 | H3S, H3X | Appleton / CDN upper |
| 8 | H2X, H3H | Sherbrooke O / Downtown |
| 9 | J5Y, J5Z, J6A | Repentigny — **NE apex** |
| 10 | H2M | Chabanel / Ahuntsic |
| 11 | H3N, H2V | Park-Extension / Outremont — **last** |

---

## CRITICAL RULES (all circuits)

1. **Home (H4N) always departs first** — never skip this.
2. **32 Rue Vermette = always stop #1** when present.
3. **North Montreal (H2M, H3N, H2V) is LAST** on Montreal circuit — Claude's biggest recurring error is putting these first.
4. **Far apexes are visited near the end**, not the beginning (except Vermette trigger).
5. **Local stops are last** on normal days (end near home). With Vermette trigger, local stops shift to the end.

---

## ROUTE COMPARISONS LOG

| # | Date | Route | Key learning | In scheduler? |
|---|------|-------|--------------|---------------|
| 1 | May 24, 2026 | Jun 10 Montreal | South Shore middle; far east last; home base error corrected | ❌ Pending |
| 2 | May 24, 2026 | Same 12 Montreal addresses | North last confirmed; J5Y apex confirmed; home = H4N confirmed | ❌ Pending |
| 3 | May 25, 2026 | 9-stop Laval/NE circuit | Horseshoe shape confirmed; Vermette = stop #1 rule established | ❌ Pending |

---

## SCHEDULER LOGIC (current state)

- Classifies patients by FSA → circuit + step
- Plans 14 days respecting caps and ±3-day windows
- Sorts each day by circuit step order
- Stores plan in sessionStorage

**FSA table**: needs update — apply corrected step orders above once 3 confirmations per rule.

---

## PROJECT INFO

- **App**: VaPiq Clinical Suite
- **GitHub**: aatomasi-bot.github.io/Clinic-Suite/
- **Supabase**: wqlbmtjbjloxpvsbeqyb.supabase.co
- **Files**: index.html (437KB), scheduler.html (84KB), ROUTE_PREFERENCES.md

---

## HOW TO USE THIS FILE

At the start of a new Claude session:
1. Open this file from GitHub
2. Paste its full contents into Claude
3. Claude restores full context instantly

When sharing a new route comparison:
- Share both maps (your preferred + Claude's output)
- Claude updates the log and extracts rules
- 3 confirmations → rule applied to scheduler.html

---

*Maintained by Claude. Part of VaPiq Clinical Suite.*
*Last updated: May 25, 2026 — Vermette trigger rule added. Laval horseshoe circuit documented.*
