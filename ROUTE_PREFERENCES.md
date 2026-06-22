# ROUTE_PREFERENCES.md — VaPiq Clinical Suite
*Living document. Paste this at the start of every new Claude session to restore context.*

---

## HOME BASE

**H4N 1N4 — Cartierville / Saint-Laurent, Montréal**
Home is ALWAYS the departure point. It is never counted as a stop.

---

## BROWSER
**User uses Chrome on iOS (iPhone) + Chrome on iMac — NOT Safari.**

---

## SPECIAL TRIGGER RULES

### 32 Rue Vermette — Always FIRST
> When 32 Rue Vermette, Saint-Eustache is on the plan → **always STOP #1.**

### 325 Boulevard Deguire — Always LAST (confirmed Jun 1, 2026)
> **325 Boul Deguire is a patient address. When present → it goes LAST.**

---

## SAME-ADDRESS GROUPING (confirmed Jun 22, 2026)

When multiple patients share the same building (same street number + street, different apt):
- Grouped **consecutively** in route — **one MapQuest stop**
- First patient: normal scheduled time
- Each subsequent patient at same address: **+15 minutes** (not full 30-min slot)
- `copyDayAddresses()` deduplicates the MapQuest list automatically
- Toast confirms: "2 same-building duplicates removed"

---

## WEEKDAY SORT — Circuit B Goes LAST (confirmed Jun 22, 2026)

**Problem fixed:** Circuit B patients (H4J, H4K border zone, s=1) were being placed FIRST on weekdays due to raw step sort. They should come LAST after sweeping SW→NE Montreal.

**`weekdayKey()` function:**
- Circuit A → step value directly (1–11)
- Circuit B → step + 20 (always after all Circuit A)

| Effective Key | Zone |
|---------------|------|
| 1–11 | Circuit A: NDG → Lachine → Downtown → Rosemont → Ahuntsic → Mtl-Nord → Mtl-Est |
| 21 | Circuit B: Border zone (H4J, H4K, H4L, H3M) |
| 22–25 | Circuit B: Ahuntsic N → Laval → Pierrefonds → West Island |

---

## MONTREAL CIRCUIT A — Step Order

| Step | FSA(s) | Neighbourhood |
|------|--------|---------------|
| 1 | H3W, H4A | NDG / Côte-St-Luc |
| 2 | H4B | NDG south / Cavendish |
| 3 | H8S, H8R, H8P, H8N, H8T, H8Y, H3E, H4E | Lachine / LaSalle / Nun's Island |
| 4 | H4G, H4C, H3J, J5R, J4W, J4G | Verdun / St-Henri / South Shore |
| 5 | H3H, H3Y, H3T, H3S, H3X | Downtown W / Westmount / CDN |
| 6 | H2X, H4P | Downtown / Snowdon |
| 7 | H2V, H2T, H2K | Outremont / Plateau / HoMa |
| 8 | H1Y, H1X | Rosemont |
| 9 | H2M, H2N, H2C, H3N, H3L, H4M, H4S | Ahuntsic / Chabanel / Park-Ex |
| 10 | H1H, H1G, H1J | Montreal-Nord / Anjou |
| 11 | H1B | Montréal-Est — **absolute last** |

---

## FRIDAY CIRCUIT B — Laval Horseshoe Arc

| Position | FSA(s) | circBKey | Notes |
|----------|--------|----------|-------|
| Border | H4N, H4L, H3M | 10 | Near home — first |
| Ahuntsic N | H2B, H1Z | 14 | |
| Laval entry | H7N | 16 | Entry bridge — first in Laval |
| Laval NE apex | H7E, H7C, H7M, H7P, H7L | 17 | Go far first |
| Laval central | H7A, H7T, H7S, H7K, H7V, H7W | 18 | |
| Laval SW exit | H7G, H7R | 19 | Last in Laval |
| Pierrefonds/SE | H8Z, J7P, J7R | 22 | After Laval |
| West Island | H9x, J7W | 28 | **Absolute last** |

---

## SATURDAY RULES

- **Start at FARTHEST patient** from home
- Sweep progressively back toward home (H4N)
- Last patient = closest to home
- First appointment: **8:00 AM**

---

## CRITICAL RULES

1. **Home (H4N) always departs first**
2. **32 Rue Vermette = always stop #1**
3. **325 Boul Deguire = always LAST**
4. **Circuit B comes AFTER Circuit A on weekdays** (weekdayKey)
5. **Same-address patients = 1 MapQuest stop, 15-min apart**
6. **North Montreal (H2M, H3N) is LATE** — not first

---

## KEY FSA OVERRIDES

| FSA | Circuit | Step | Notes |
|-----|---------|------|-------|
| H3M | B | 1 | Cartierville border → Friday |
| H8Z | B | 4 | Pierrefonds |
| H1H, H1G | A | 10 | Montreal-Nord |
| J5Y, J5Z, J6A | A | 9 | Repentigny — NE apex |

---

## ROUTE COMPARISONS LOG

| # | Date | Circuit | Key learning | Applied? |
|---|------|---------|--------------|----------|
| 1 | May 24 | Montreal | South Shore middle; north last | ✅ |
| 2 | May 24 | Montreal | H4N home confirmed | ✅ |
| 3 | May 25 | Laval/NE | Horseshoe; Vermette stop #1 | ✅ |
| 4 | May 25 | Saturday | Start farthest; end near home | ✅ |
| 5 | May 25 | Montreal | H1B far east last; H2V step 7 | ✅ |
| 6 | May 25 | Friday | Border→Laval→West Island | ✅ |
| 7 | Jun 1 | Both | H3M→B; Deguire last; H1H step 10 | ✅ |
| 8 | Jun 3 | Both | City-name fallback; H7 sub-steps | ✅ |
| 9 | Jun 11 | Friday | Laval horseshoe arc confirmed | ✅ |
| 10 | Jun 22 | Tuesday | weekdayKey + same-address 15-min grouping | ✅ |

---

## PROJECT INFO

- **App**: VaPiq Clinical Suite
- **GitHub**: aatomasi-bot.github.io/Clinic-Suite/
- **Supabase**: wqlbmtjbjloxpvsbeqyb.supabase.co

*Last updated: Jun 22, 2026*
