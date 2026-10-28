# How Rabbithole ranks music

> Streams can be bought. Genuine DJ support is harder to manufacture.

Everything here is measured from **set appearances in sets Rabbithole has indexed**. It
shows what DJs played, not why: it can't tell organic support from promotion, and the
index is uneven (not every DJ or performance is in it). Pages show how many sets and DJs
a number is based on, and say so when that's too few to trust.

The code: `src/catalog/support.ts` (metrics and formulas, all tunables in `SUPPORT`),
`src/catalog/discover.ts` (the modes), `src/catalog/alongside.ts`,
`src/catalog/recommend.ts`, `src/catalog/artwork.ts`. Tests: `test/support.test.ts`.

## What counts as a play

- One **set appearance** = one indexed set that played the track. Twice in one set is still one.
- Only **third-party** plays: if any of the set's DJs is credited on the recording in any role
  (artist, featured, remixer/editor, mashup source), that set doesn't count for that track.
- **Unidentified IDs** never count. Originals, remixes, edits, VIPs, bootlegs and mashups are
  separate recordings, so a remix's support never inflates the original's.
- **Dates are performance dates** (`sets.performed_on`), never when Rabbithole collected the set.
  A 2024 set collected today counts in 2024.
- **Canonical DJs**: verified aliases are one DJ (`artist_aliases`, e.g. Lorenzo = Chris Lorenzo).
- **Duplicates**: the same performance indexed twice (same DJ, same event title, same day with
  ≥ 90% of identified tracks shared, or a day apart with ≥ 98%) counts once. The later copy
  is listed in `set_duplicates` and left out of every count; nothing is deleted. A tour or
  residency (different nights, similar sets) is **not** a duplicate: those are real repeats.

## Three numbers, kept apart

| Metric | Definition |
|---|---|
| **Unique DJs** (breadth) | Distinct canonical DJs with a third-party play in the period. A DJ playing it 30 times is one DJ. The most important number. |
| **Set appearances** (repeat support) | Distinct qualifying sets in the period. Also shown: how many DJs played it in 2+ sets. |
| **Recent supporting DJs** (momentum) | Distinct DJs in the last 90 days, whatever period is selected. |

Momentum extras (Playing Now and song pages):

- **New supporters**: a DJ whose first indexed play of the track is inside the period *and*
  who has an older indexed set without it. Without older sets Rabbithole can't tell "new to
  it" from "newly indexed", so they don't count as new.
- **Growth**: `(DJs now ÷ active DJs now) ÷ (DJs before ÷ active DJs before) − 1`, comparing
  the period with the equally long one before it, where "active DJs" are DJs with any
  indexed set in that period (so collecting more sets doesn't look like growth). Shown only
  when both periods have ≥ 5 active DJs and ≥ 2 DJs played it before; "new" when nobody did
  before and ≥ 3 do now; otherwise "not enough earlier data".

## Repeat support with diminishing returns

Each DJ's plays of a track become one **contribution** between 1 and 2 DJ-equivalents:

```
effective plays = Σ over their sets of (1 for live/unknown, 0.75 for radio/podcast),
                  counting at most 8 episodes of any one recurring show, never below 1
contribution    = min(1 + 0.25 · log2(effective plays), 2)
```

1 play → 1.0, 2 → 1.25, 4 → 1.5, 16+ → 2.0. One DJ can never add more than one extra DJ's
worth, however many radio episodes they host.

**Back-to-back sets**: a B2B is one selection shared by its DJs. Each DJ still counts toward
breadth, but in scores a DJ whose only plays were B2Bs with *n* DJs counts `1/n`
(`share`; 1 if they ever played it in a set of their own).

### Set types and recurring shows

`sets.set_type` comes from the source page's own description ("Tracklist / playlist for
live set / radio show / podcast …"), with the evidence in `set_type_evidence`; `unknown`
when the page doesn't say. It's never guessed from track counts. `series_key` is the
show or event the page links in the set's title (`/source/…`). Radio and podcast episodes
count 0.75 toward repeats and at most 8 episodes per show count. **Breadth is never
reduced**: a DJ who hosts a show is still one full supporting DJ.

## The three modes

All three rank third-party tracks played by the selected DJs (all indexed DJs, the DJs
you follow, or a custom pick) in the selected period and genre.

**Most Played** (default: all time)

```
score = Σ over supporting DJs of share · (1 + 0.5 · (contribution − 1))
```

That's the number of DJs, plus up to half a DJ each for coming back to it. 15 DJs once each
= 15; one DJ thirty times = 1.5. Ties: more DJs, more sets, more recent, then name.

**Playing Now** (default: 90 days; also 30 days, 6 and 12 months)

```
score = Σ over supporting DJs of share · (1 + 0.5 · (contribution − 1))
                               · 0.5 ^ (days since their latest play ÷ half-life)
                               · (1.25 if they're a new supporter)
half-life = max(14 days, period ÷ 3)        (30 days for the 90-day default)
```

So ten DJs this month beat twelve DJs three months ago; old sets collected today never
appear (their performance date is outside the window).

**Deep Cuts** (default: 12 months)

```
score = Σ over selected DJs of share · contribution        (full repeat contribution)
        × 3 ÷ (3 + DJs anywhere in the index who play it)  (rarity)
        × sets ÷ (sets + 1)                                 (evidence)
```

Requirements: 2+ qualifying sets (and with several DJs selected, 2+ DJs or 3+ sets), and
played by no more than 1% of indexed DJs (at least 4). A one-off play never qualifies.
Rarity saturates quickly, so once a track is rare it's repeat support from the selected DJs
that decides. Example: 5 Chris Lorenzo sets + 3 other DJs (4 DJs in all) scores
`1.58 × 3/7 × 5/6 ≈ 0.57`; the same 5 sets + 120 other DJs is excluded (too widely played),
and would score `≈ 0.03` if it weren't. "Rare here" is not proof of "rare in the world":
below 50 indexed sets the page says rarity can't be judged.

**Intros / 90 + 5** are unchanged: first (last) 2 lines of sets with 10+ tracks; 2+ such
sets (by 2+ DJs when several are selected); ≥ 20% of its plays at that moment; ranked by
DJs, then share.

## Played alongside it

Over **every eligible indexed set** that plays the song (all time; duplicates removed),
for each other identified track sharing 2+ of those sets:

```
Goes with it  = shared ÷ √(this song's sets × the other song's sets)
                × shared DJs ÷ (shared DJs + 2)
Most shared   = shared (raw count)
```

The first factor is high only when both songs mostly appear together (a hit that's in
every set scores low). The second keeps one DJ's weekly show repeating a pair from looking
like many DJs agreeing. 4 of 4 sets (4 DJs, song in 60 sets) ≈ 0.17; 25 of 50 (10 DJs) ≈
0.38. Each row shows `shared of anchor sets · DJs · in N overall`, and the sets behind it
open under the row. Below 10 sets with the song, the section says it's a hint, not a
pattern.

## Who made a track (attribution)

Roles come from how the tracklist writes the line (`credits()` in `identity.ts`): main,
featured (vocalists are written "ft."), remixer (the creator of a remix/edit/VIP/bootleg/
rework/mashup), mashup_component ("A vs. B - X vs. Y" or "X X Y" titles). Sampled artists
are never inferred: the source doesn't say.

- **Production credit** = the version's creator, or a main artist of an original.
  `Technotronic - Pump Up The Jam (AYYBO Edit)` is AYYBO's production; Technotronic is its
  **original artist**, credited as such, never as the edit's maker.
- **Own productions** (artist pages): their originals and versions first, then songs they're
  featured on, then other people's versions of their songs (labelled). Mashups that merely
  use their song are never listed.
- **Who they play most** counts production credit only (a remix counts for its remixer).
- **Artists chart**: a set counts 1 for production credit, ½ for a feature or someone else's
  version of their song, 0 for a mashup ingredient. So Rihanna or The Temper Trap don't rank
  just because DJs play mashups and remixes of their songs. (DJ lists only ever contain
  people who performed indexed sets.)

## Pictures

Rabbithole has no cover art of its own (`artwork.ts`), so it labels what it shows:

1. **SoundCloud artwork** of the linked upload, when a person confirmed the link or the
   match was ≥ 90% certain.
2. A version (remix/edit/VIP/bootleg/rework): a photo of **its creator** (AYYBO for his edit).
3. An original: a photo of its first main artist.
4. Otherwise a neutral placeholder.

Featured vocalists' and mashup sources' photos are never used. Hovering a picture says which
kind it is. A missing picture says nothing about whether a track is released.

## Recommended sets

Sets performed in the last year, each scored (with `sat(x, k) = x ÷ (x + k)`):

```
(3 · sat(your liked songs in it, 2)
 + 2 · sat(its tracks that DJs you follow play elsewhere, 6)
 + 1.5 · sat(tracks played by only 2–3 DJs anywhere, 4)
 + 1 · sat(distinct third-party tracks, 20)
 + share of lines in your genre (or your likes' top genres))
× 0.5 ^ (days ago ÷ 90) × (0.85 for radio/podcast)
```

Then a diversity pass: one set per DJ and per recurring show, and no near-copy (80%+ of the
same tracks) of a set already picked, before anything repeats. Reasons shown ("Plays 5 of
your liked songs", "Contains tracks played by 4 DJs you follow", "Includes 3 tracks with
limited broader DJ support") are the counts behind the score.

## Freshness and caching

Rankings are computed from the database on request. The per-track play data is cached in
memory per database and keyed by a **catalog version** (set count, latest save or refresh,
alias count, duplicate count, credit rules version), checked on every request. So a newly
saved set, a new alias or re-derived credits show up on the next page load, and follow /
unfollow changes take effect immediately (the selected DJs are part of the query, not the
cache).
