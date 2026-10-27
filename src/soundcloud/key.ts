// SoundCloud's key_signature ("Gb:min", "C:maj") as DJs read it: a key name and its
// Camelot code ("F#m", "11A"), the wheel used for harmonic mixing.

const PITCH: Record<string, number> = {
  C: 0, "B#": 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4, "E#": 5, F: 5,
  "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11,
};

// Names by pitch class, spelled the way DJ software usually shows them.
const MINOR_NAME = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];
const MAJOR_NAME = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
// Camelot numbers by pitch class: minor keys are "A", major keys "B".
const MINOR_CAMELOT = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
const MAJOR_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

/** "Gb:min" -> { key: "F#m", camelot: "11A" }; undefined for anything it can't read. */
export function musicalKey(signature: string | null | undefined): { key: string; camelot: string } | undefined {
  const m = signature?.trim().match(/^([A-Ga-g])([#b♯♭]?)\s*[:\s]?\s*(maj(?:or)?|min(?:or)?|m)?$/i);
  if (!m) return undefined;
  const note = `${m[1]!.toUpperCase()}${m[2]!.replace("♯", "#").replace("♭", "b")}`;
  const pc = PITCH[note];
  if (pc === undefined) return undefined;
  const minor = /^m/i.test(m[3] ?? "maj") && !/^maj/i.test(m[3] ?? "");
  return minor ? { key: MINOR_NAME[pc]!, camelot: `${MINOR_CAMELOT[pc]}A` } : { key: MAJOR_NAME[pc]!, camelot: `${MAJOR_CAMELOT[pc]}B` };
}
