import { invoke, invokeBinary } from "./tauri.js";
import type {
  CatalogSong,
  EditorMeta,
  LastUpload,
  Manifest,
  ProjectData,
  ProjectSummary,
  SessionInfo,
  SifNote,
} from "./types.js";

export interface UploadResult {
  music_id: number;
  last_upload: LastUpload | null;
}

// --- server ---------------------------------------------------------------

export const connect = (server: string) => invoke<unknown>("connect", { server });
export const login = (uid: number, password: string) =>
  invoke<void>("login", { uid, password });
export const logout = () => invoke<void>("logout");
export const sessionInfo = () => invoke<SessionInfo>("session_info");
export const listMine = () => invoke<CatalogSong[]>("list_mine");
export const browseSongs = () => invoke<CatalogSong[]>("browse_songs");
export const setVisibility = (
  musicId: number,
  visibility: string,
  sharedWith: number[],
  downloadsDisabled: boolean,
) =>
  invoke<void>("set_visibility", {
    musicId,
    visibility,
    sharedWith,
    downloadsDisabled,
  });
export const deleteSong = (musicId: number) => invoke<void>("delete_song", { musicId });
export const fetchJacket = (musicId: number) =>
  invoke<ArrayBuffer>("fetch_jacket", { musicId });
export const uploadProject = (
  projectId: string,
  visibility: string,
  sharedWith: number[],
  downloadsDisabled: boolean,
) =>
  invoke<UploadResult>("upload_project", {
    projectId,
    visibility,
    sharedWith,
    downloadsDisabled,
  });
export const updateSong = (projectId: string, musicId: number) =>
  invoke<UploadResult>("update_project", { projectId, musicId });
export const downloadSongToProject = (musicId: number) =>
  invoke<ProjectSummary>("download_song_to_project", { musicId });

// --- local projects --------------------------------------------------------

export const projectList = () => invoke<ProjectSummary[]>("project_list");
export const projectCreate = (name: string, artist: string) =>
  invoke<ProjectSummary>("project_create", { name, artist });
export const projectLoad = (id: string) => invoke<ProjectData>("project_load", { id });
export const projectSave = (
  id: string,
  manifest: Manifest,
  editor: EditorMeta,
  charts: Record<string, SifNote[]>,
) => invoke<void>("project_save", { id, manifest, editor, charts });
export const projectDelete = (id: string) => invoke<void>("project_delete", { id });
export const projectSetAudio = (id: string, bytes: ArrayBuffer) =>
  invokeBinary<string>("project_set_audio", bytes, { "x-project-id": id });
export const projectSetJacket = (id: string, bytes: ArrayBuffer) =>
  invokeBinary<string>("project_set_jacket", bytes, { "x-project-id": id });
export const projectLoadAudio = (id: string) =>
  invoke<ArrayBuffer>("project_load_audio", { id });
export const projectGetJacket = (id: string) =>
  invoke<ArrayBuffer>("project_get_jacket", { id });
export const projectExport = (id: string) => invoke<string>("project_export", { id });
export const projectImportZip = (bytes: ArrayBuffer) =>
  invokeBinary<ProjectSummary>("project_import_zip", bytes);

export interface ChartCandidate {
  name: string;
  kind: string; // "text" | "notedata"
  content: string;
}
export const bundleExtractCharts = (bytes: ArrayBuffer) =>
  invokeBinary<ChartCandidate[]>("bundle_extract_charts", bytes);

// --- Bandori batch import ----------------------------------------------------

export interface BandoriSongEntry {
  stem: string;
  difficulties: string[];
  bgm_id: string | null;
  has_audio: boolean;
  has_jacket: boolean;
}
export interface BandoriCatalog {
  songs: BandoriSongEntry[];
  loose_bgm: number;
  loose_jackets: number;
}
export const bandoriScan = (sessionId: string, bytes: ArrayBuffer) =>
  invokeBinary<BandoriCatalog>("bandori_scan", bytes, { "x-session-id": sessionId });
export const bandoriChart = (sessionId: string, stem: string, difficulty: string) =>
  invoke<string>("bandori_chart", { sessionId, stem, difficulty });
export const bandoriMeta = (sessionId: string) =>
  invoke<Record<string, { title: string | null; band: string | null }>>("bandori_meta", {
    sessionId,
  });
export const bandoriImportSong = (
  sessionId: string,
  stem: string,
  name: string,
  artist: string,
  bpm: number | null,
  levels: Record<number, number>,
  charts: Record<number, SifNote[]>,
) =>
  invoke<{ summary: ProjectSummary; audio: string }>("bandori_import_song", {
    sessionId,
    stem,
    name,
    artist,
    bpm,
    levels,
    charts,
  });
export const bandoriClose = (sessionId: string) => invoke<void>("bandori_close", { sessionId });

// --- native audio engine (Linux PulseAudio; absent elsewhere) ---------------

export const nativeAvailable = () => invoke<boolean>("native_available");
export const nativePlay = (fromSec: number, rate: number) =>
  invoke<void>("native_play", { fromSec, rate });
export const nativePause = () => invoke<number>("native_pause");
export const nativePosition = () =>
  invoke<{ raw: number; display: number; playing: boolean }>("native_position");
export const nativeSetTicks = (times: number[], enabled: boolean) =>
  invoke<void>("native_set_ticks", { times, enabled });
