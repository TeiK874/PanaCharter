// Shapes shared with the Rust backend and the ew server API.

/** One note in the SIF1/NPPS4 upload schema (§4a of the API spec). */
export interface SifNote {
  timing_sec: number;
  /** Lane 1–9, right-to-left (1 = rightmost). */
  position: number;
  /** 1 tap, 2 simultaneous marker (=tap), 3 hold, 4 star, 11/12 slide, 13 slide ending in a hold. */
  effect: number;
  /** Hold duration in seconds when effect == 3 or 13. */
  effect_value: number;
  /** Slide chain id (effect 11/12/13 only). Notes sharing a value > 1 chain together in time
   *  order; 1/absent means "not chained", matching SIF1's own default. */
  notes_level?: number;
}

export interface LevelMeta {
  level: number;
  level_number: number;
}

export interface Manifest {
  format: number;
  name: string;
  name_en: string;
  short_name: string;
  kana: string;
  artist: string;
  artist_en: string;
  attribute: number; // 1 smile, 2 pure, 3 cool
  band_category: string;
  bpm: number | null;
  preview_start_sec: number | null;
  preview_length_sec: number | null;
  levels: LevelMeta[];
}

export interface LastUpload {
  server: string;
  music_id: number;
  audio_mtime_ms?: number | null;
  jacket_mtime_ms?: number | null;
}

export interface EditorMeta {
  offset_sec: number;
  snap: number;
  zoom: number;
  orientation: string;
  last_upload: LastUpload | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  artist: string;
  attribute: number;
  levels: number[];
  has_audio: boolean;
  has_jacket: boolean;
  modified_ms: number;
}

export interface ProjectData {
  id: string;
  manifest: Manifest;
  editor: EditorMeta;
  charts: Record<string, SifNote[]>;
  audio_ext: string | null;
  jacket_ext: string | null;
}

export interface SessionInfo {
  server: string | null;
  uid: number | null;
  logged_in: boolean;
}

export interface CatalogLevel {
  level: number;
  level_number: number;
  full_combo: number;
}

/** Catalog song blob (§7), plus per-endpoint extras from /mine and /browse. */
export interface CatalogSong {
  music_id: number;
  name: string;
  name_en: string;
  artist: string;
  attribute: number;
  band_category: string;
  bpm: number;
  levels: CatalogLevel[];
  // /custom_song/mine extras
  visibility?: string;
  shared_with?: number[];
  downloads_disabled?: boolean;
  // /custom_song/browse extras
  uploader?: string;
  mine?: boolean;
}

export const ATTRIBUTES: Record<number, string> = { 1: "Smile", 2: "Pure", 3: "Cool" };

export const BAND_CATEGORIES = [
  "OTHER",
  "MUSE",
  "AQOURS",
  "NIJIGAKU",
  "LIELLA",
  "HASUNOSORA",
  "YOHANE",
  "NONE",
];

export const DIFFICULTIES: Record<number, { name: string; short: string }> = {
  1: { name: "Normal", short: "N" },
  2: { name: "Hard", short: "H" },
  3: { name: "Expert", short: "EX" },
  4: { name: "Master", short: "M" },
};
