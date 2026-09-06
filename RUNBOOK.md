# OPS in One Word — Instruction Manual (OPSPHERE · Round 2)

**For whoever is hosting this game.** You're setting up an already-built multiplayer
buzzer game — **OPS in One Word** (OPSPHERE, Operations Club, IBS Bengaluru). It runs
on the free tiers of **Supabase** (database), **GitHub** (stores the code), and
**Vercel** (hosts the website). No coding needed. Follow the numbered steps.

**The three roles**
- **Admin** — sets up questions, watches the live scorecard, holds the safety controls
  (pause, reset, restart, hide questions). Logs in by picking **Admin** + the admin password.
- **Game Master (GM)** — runs the game and their laptop **is the projector screen**:
  shows each question + timer, sees the top-3 fastest buzzers, marks answers right/wrong,
  advances. Logs in by picking **Game Master** + the GM password.
- **Team (player)** — one login per team, one device = the buzzer. Picks **Team**, types
  a team name + the team password, then buzzes.

**Login domain:** `ops.ibsb.gg` (made-up emails — nobody needs a real inbox).

> **How this differs from the Supply Chain manual** (so you don't hunt for missing steps):
> this game has **no `pg_cron` step** and **no "turn off email confirmation" step**. The
> timer is handled by the database itself, and login is a simple role-password check.
> Fewer steps on purpose.

---

## PART 1 — Supabase (database + accounts)

> If you already ran some of this during setup, **do it again from scratch here** — the
> database script was updated after the first walkthrough, so this is the final version.
> Re-running is safe; it rebuilds cleanly.

1. **supabase.com** → sign in → **New project**. Name it (e.g. `opsphere-round2`), set a
   **strong database password** and save it, pick a nearby **region** (South Asia /
   Mumbai for IBS Bengaluru), **Create**. Wait ~2 minutes.
   *On the create screen: leave **Enable Data API** ON; leave **Automatically expose new
   tables** and **Enable automatic RLS** OFF. The script controls access itself.*

2. **Run the database script.** Sidebar → **SQL Editor** → **New query**. Open
   `database/database-setup.sql`, copy **everything**, paste, **Run**. A warning about
   destructive operations on an empty project is normal — run it anyway. You want green
   **Success. No rows returned.** (This one script builds every table, security rule, and
   all the game logic.)

3. **Set your passwords.** New query, paste, **Run**:
   ```sql
   update app_config set
     admin_password  = '19990909',
     gm_password     = '12345678',
     player_password = '9211420'
   where id;
   ```
   (Change the values if you like. "Success. No rows returned" is correct.)

4. **Create your team slots** (25 — your real teams plus spares; empty ones never show on
   the leaderboard). New query, paste, **Run**:
   ```sql
   insert into teams (team_number, login_email)
   select g, 'team'||g||'@ops.ibsb.gg'
   from generate_series(1, 25) g
   on conflict (team_number) do nothing;
   ```

5. **Check it worked.** Run each line on its own (the editor only shows the last result):
   ```sql
   select count(*) from teams;      -- expect 25
   select count(*) from questions;  -- expect 10 (placeholders)
   ```

6. **Copy two values for Vercel.** Sidebar → **Project Settings** → **API**: the
   **Project URL** and the **Publishable key** (`sb_publishable_…`; a legacy **anon
   public** key also works). *Never* use the secret / service_role key.

Realtime is already on and configured by the script — nothing else to toggle.

---

## PART 2 — GitHub (stores the code)

1. **First, drop in the two logo files** (see **Branding** below) so the deployed site is
   on-brand: put `logo.png` and `ibs-logo.png` into the **`public/`** folder before you
   upload. (You can also add them later and re-upload — the site just shows text
   fallbacks until then.)
2. **github.com** → **New repository** (Private is fine) → Create.
3. **Add file → Upload files** → drag in the folders (`app`, `lib`, `public`, `database`)
   and the loose files (`package.json`, `next.config.mjs`, `.gitignore`,
   `.env.local.example`, `RUNBOOK.md`). Commit. Keep the folder structure intact
   (`app/page.js`, `app/player/page.js`, `app/gm/page.js`, `app/admin/page.js`,
   `app/components/Header.js`, `lib/supabaseClient.js`, `database/database-setup.sql`, …).

---

## PART 3 — Vercel (hosts the site)

1. **vercel.com** → sign up with GitHub → **Add New… → Project** → **Import** the repo.
2. It should detect **Next.js**. Under **Environment Variables**, add (names exact):
   - `NEXT_PUBLIC_SUPABASE_URL` = your Project URL (Part 1, step 6)
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = your Publishable key
3. **Deploy** (~1–2 min). You get a live `…vercel.app` URL. Any later GitHub change
   auto-redeploys in ~1–2 min.

---

## PART 4 — First login & smoke test

Do this once, quietly, before the event, to prove everything works end to end.

1. Open the live URL → the sign-in screen (OPSPHERE header, "OPS in One Word").
2. **On one device: log in as Game Master** — pick **Game Master**, password `12345678`,
   Enter. You land on the GM screen → **Load first question**.
3. **On two more devices (or browser tabs): log in as Team** — pick **Team**, type a team
   name, password `9211420`, Join. Each claims a team slot.
4. On the GM screen press **Start question**. The teams see the timer + BUZZ. Have them
   buzz. When the timer ends, the GM screen shows the **fastest-first ranking**.
5. Mark the top team **✓ Correct** (or ✗ to pass down the list). Then **Next question →**.
6. **In a fourth tab: log in as Admin** — pick **Admin**, password `19990909`. Watch the
   **live scorecard** update as you mark answers.

If that loop works, you're ready. If anything looks off, note which screen and step.

---

## Replacing the placeholder questions (do before the event)

The game ships with **10 `[PLACEHOLDER]` questions** so it runs out of the box. They are
**not real content** — replace them with your actual bank. Two ways:

**A. In the app (no SQL).** Log in as **Admin**. If a game is running, click **Pause
game** first (editing is locked while running). Use the **Questions** panel to add, edit,
reorder (↑/↓), and delete. Timer must be **5 or 10** seconds.

**B. Bulk paste (fastest for a big set).** Supabase → SQL Editor. This clears the
placeholders and inserts your set — add as many rows as you want (one per line):
```sql
delete from questions where is_placeholder = true;

insert into questions (question_text, base_points, time_limit_seconds, segment_name, order_index) values
  ('Your real question 1', 8,  10, 'Operations Basics',  1),
  ('Your real question 2', 12,  5, '5-Second Challenge', 2),
  ('Your real question 3', 12, 10, 'Identify the Concept', 3);
```
Columns: **text**, **base points** (bigger = harder question worth more), **timer** (5 or
10 only), **segment** (any label), **order_index** (play order: 1, 2, 3 … keep them
unique and gap-free). The GM's "Question X of N" adjusts to however many you add.

---

## Branding (required before "on brand")

- Put the **real** `logo.png` (OPSPHERE emblem) and `ibs-logo.png` (institution) into
  **`public/`**, exact filenames — never redraw or approximate the emblem. The header
  logo + faint watermark then appear with no code change. Until then, a text fallback
  shows.
- The **"Built by Brahmajit Saha" footer credit is built in and must stay visible** in
  every deployment, including any rebranded copy for another club. A reuser may add their
  own credit alongside it, but never removes the original.
- A different campus swaps `ibs-logo.png` for their own logo (same filename).

---

## Running the game live (GM + Admin on the night)

**Game Master** (drives tempo; laptop mirrored to the projector):
- **Load first question** → the room sees "Question 1" (not the text yet).
- **Start question** → the question + timer appear to everyone at once; teams buzz.
- Timer ends → the **top-3 fastest** appear. Call the #1 team, hear their one-word answer,
  press **✓ Correct** or **✗ Wrong**. Wrong drops to #2, then #3 (max 3 attempts; if all
  three miss, the question scores nothing).
- **Next question →** and repeat. A row flagged **⚠ check** means that buzz's timing looks
  suspicious — use your judgement before awarding it.

**Admin** (quiet safety net; scorecard stays on the Admin screen, never the projector):
- **Pause game** before changing anything (questions, timers). Resume when ready.
- **Reset current question** — clears that question's buzzes/marks and re-opens it
  (other scores untouched; a spent PASS is refunded).
- **Void current question** — nobody scores it; move on.
- **Hide questions from players** — pushes everyone to read off the projector (kills
  device text-skew). Timer + BUZZ stay on their phones.
- **Restart game** — wipes **all** scores back to question 1. Big red button; it asks to
  confirm. Use only between full runs.

**Scoring, for reference:** a correct answer scores `base_points × (time_limit − buzz_time)`,
rounded; a wrong answer loses half that. Faster correct buzzes score more; teams can go
negative (that's expected, not a bug).

---

## Good to know

- **Free Supabase pauses after ~7 days idle.** If the site won't load, the database is
  asleep: open the Supabase dashboard and un-pause it. **Load the site once in the days
  before the event, and again the morning of** — a paused project 5 minutes before Round 2
  is the one avoidable disaster.
- **Reset between events / practice runs:** log in as Admin → **Restart game** (wipes
  scores, keeps your questions and team slots). To also clear the team names people typed,
  run in SQL Editor: `update teams set display_name = null, passes_remaining = 3 where true;`
- **Changing the login domain** (from `ops.ibsb.gg`): run
  `update app_config set login_domain = 'yourdomain.gg' where id;` — that's the only place
  it lives.
- **Everything is on free tiers.** Your load (a dozen-plus teams) is tiny and well within
  the free limits.

---

*Based on OPSPHERE by Brahmajit Saha (Operations Club, IBS Bengaluru).*
