//! Minimal Unity AssetBundle (UnityFS) reader — just enough to pull beatmaps
//! out of game bundles for the chart importer:
//!
//! - TextAssets (class 49) whose payload looks like text → Bandori `.note`
//!   scores and similar plaintext charts.
//! - MonoBehaviours (class 114) that parse as SIF2 `Aoharu.NoteData` (layout
//!   ground-truthed from the decompiled NoteData.cs) → re-serialized as the
//!   served chart JSON shape, which the frontend's SIF2 converter accepts.
//!
//! Type trees are skipped, not interpreted; MonoBehaviours that don't validate
//! as NoteData are silently ignored. Tested against SIF2 (Unity 2021.3,
//! SerializedFile v22) and Bandori musicscore bundles.

use serde::Serialize;

#[derive(Serialize)]
pub struct ChartCandidate {
    pub name: String,
    pub kind: String, // "text" | "notedata"
    pub content: String,
}

// ---------------------------------------------------------------------------
// byte cursor
// ---------------------------------------------------------------------------

pub(crate) struct Cur<'a> {
    b: &'a [u8],
    p: usize,
}

pub(crate) type R<T> = Result<T, String>;

pub(crate) fn eof() -> String {
    "Unexpected end of bundle data".into()
}

impl<'a> Cur<'a> {
    pub(crate) fn new(b: &'a [u8]) -> Self {
        Self { b, p: 0 }
    }
    pub(crate) fn take(&mut self, n: usize) -> R<&'a [u8]> {
        let end = self.p.checked_add(n).ok_or_else(eof)?;
        if end > self.b.len() {
            return Err(eof());
        }
        let s = &self.b[self.p..end];
        self.p = end;
        Ok(s)
    }
    pub(crate) fn skip(&mut self, n: usize) -> R<()> {
        self.take(n).map(|_| ())
    }
    pub(crate) fn align(&mut self, n: usize) {
        let rem = self.p % n;
        if rem != 0 {
            self.p += n - rem;
        }
    }
    pub(crate) fn u8(&mut self) -> R<u8> {
        Ok(self.take(1)?[0])
    }
    pub(crate) fn u16(&mut self, be: bool) -> R<u16> {
        let s: [u8; 2] = self.take(2)?.try_into().unwrap();
        Ok(if be { u16::from_be_bytes(s) } else { u16::from_le_bytes(s) })
    }
    pub(crate) fn u32(&mut self, be: bool) -> R<u32> {
        let s: [u8; 4] = self.take(4)?.try_into().unwrap();
        Ok(if be { u32::from_be_bytes(s) } else { u32::from_le_bytes(s) })
    }
    pub(crate) fn i32(&mut self, be: bool) -> R<i32> {
        Ok(self.u32(be)? as i32)
    }
    pub(crate) fn u64(&mut self, be: bool) -> R<u64> {
        let s: [u8; 8] = self.take(8)?.try_into().unwrap();
        Ok(if be { u64::from_be_bytes(s) } else { u64::from_le_bytes(s) })
    }
    pub(crate) fn i64(&mut self, be: bool) -> R<i64> {
        Ok(self.u64(be)? as i64)
    }
    pub(crate) fn f32(&mut self, be: bool) -> R<f32> {
        Ok(f32::from_bits(self.u32(be)?))
    }
    pub(crate) fn cstr(&mut self) -> R<String> {
        let start = self.p;
        while self.p < self.b.len() && self.b[self.p] != 0 {
            self.p += 1;
        }
        if self.p >= self.b.len() {
            return Err(eof());
        }
        let s = String::from_utf8_lossy(&self.b[start..self.p]).into_owned();
        self.p += 1;
        Ok(s)
    }
    /// Unity serialized string: u32 length + bytes, aligned to 4.
    pub(crate) fn ustring(&mut self, be: bool) -> R<String> {
        let len = self.u32(be)? as usize;
        if len > 0x0100_0000 {
            return Err("Implausible string length".into());
        }
        let s = String::from_utf8_lossy(self.take(len)?).into_owned();
        self.align(4);
        Ok(s)
    }
}

// ---------------------------------------------------------------------------
// UnityFS container
// ---------------------------------------------------------------------------

fn decompress(kind: u32, data: &[u8], out_size: usize) -> R<Vec<u8>> {
    match kind {
        0 => Ok(data.to_vec()),
        1 => {
            // Unity LZMA: 5-byte props, then raw stream, unpacked size external
            let mut input = std::io::Cursor::new(data);
            let mut out = Vec::with_capacity(out_size);
            lzma_rs::lzma_decompress_with_options(
                &mut input,
                &mut out,
                &lzma_rs::decompress::Options {
                    unpacked_size: lzma_rs::decompress::UnpackedSize::UseProvided(Some(
                        out_size as u64,
                    )),
                    ..Default::default()
                },
            )
            .map_err(|e| format!("LZMA decompress failed: {e:?}"))?;
            Ok(out)
        }
        2 | 3 => lz4_flex::block::decompress(data, out_size)
            .map_err(|e| format!("LZ4 decompress failed: {e}")),
        other => Err(format!("Unsupported bundle compression type {other}")),
    }
}

struct Node {
    offset: u64,
    size: u64,
    path: String,
}

/// Parse a UnityFS bundle into its contained files.
pub(crate) fn read_unityfs(bytes: &[u8]) -> R<Vec<(String, Vec<u8>)>> {
    let mut c = Cur::new(bytes);
    if c.take(8)? != b"UnityFS\0" {
        return Err("Not a UnityFS bundle".into());
    }
    let version = c.u32(true)?;
    let _web_ver = c.cstr()?;
    let _web_rev = c.cstr()?;
    let _size = c.u64(true)?;
    let compressed_info = c.u32(true)? as usize;
    let uncompressed_info = c.u32(true)? as usize;
    let flags = c.u32(true)?;
    if version >= 7 {
        c.align(16);
    }

    let info_bytes = if flags & 0x80 != 0 {
        // blocks info at the end of the file
        if compressed_info > bytes.len() {
            return Err(eof());
        }
        bytes[bytes.len() - compressed_info..].to_vec()
    } else {
        c.take(compressed_info)?.to_vec()
    };
    let info = decompress(flags & 0x3F, &info_bytes, uncompressed_info)?;

    let mut ic = Cur::new(&info);
    ic.skip(16)?; // data hash
    let block_count = ic.u32(true)? as usize;
    if block_count > 100_000 {
        return Err("Implausible block count".into());
    }
    let mut blocks = Vec::with_capacity(block_count);
    for _ in 0..block_count {
        let unc = ic.u32(true)? as usize;
        let comp = ic.u32(true)? as usize;
        let bflags = ic.u16(true)? as u32;
        blocks.push((unc, comp, bflags));
    }
    let node_count = ic.u32(true)? as usize;
    if node_count > 100_000 {
        return Err("Implausible node count".into());
    }
    let mut nodes = Vec::with_capacity(node_count);
    for _ in 0..node_count {
        let offset = ic.u64(true)?;
        let size = ic.u64(true)?;
        let _nflags = ic.u32(true)?;
        let path = ic.cstr()?;
        nodes.push(Node { offset, size, path });
    }

    if flags & 0x200 != 0 {
        c.align(16); // kArchiveBlockInfoNeedPaddingAtStart
    }
    let mut data = Vec::with_capacity(blocks.iter().map(|b| b.0).sum());
    for (unc, comp, bflags) in blocks {
        let chunk = c.take(comp)?;
        data.extend_from_slice(&decompress(bflags & 0x3F, chunk, unc)?);
    }

    nodes
        .into_iter()
        .map(|n| {
            let start = n.offset as usize;
            let end = start
                .checked_add(n.size as usize)
                .filter(|e| *e <= data.len())
                .ok_or_else(eof)?;
            Ok((n.path, data[start..end].to_vec()))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// SerializedFile
// ---------------------------------------------------------------------------

pub(crate) struct ObjectInfo {
    pub(crate) path_id: i64,
    pub(crate) class_id: i32,
    pub(crate) byte_start: u64,
    pub(crate) byte_size: u32,
}

/// Skip one SerializedType record, returning nothing — we only need class ids.
fn skip_type(c: &mut Cur, version: u32, be: bool, enable_tree: bool, is_ref: bool) -> R<i32> {
    let class_id = c.i32(be)?;
    if version >= 16 {
        c.skip(1)?; // isStrippedType
    }
    let script_index = if version >= 17 { c.u16(be)? as i16 } else { -1 };
    if version >= 17 {
        if (is_ref && script_index >= 0) || (!is_ref && class_id == 114) {
            c.skip(16)?; // script id hash
        }
    }
    c.skip(16)?; // old type hash
    if enable_tree {
        let node_count = c.u32(be)? as usize;
        let strbuf = c.u32(be)? as usize;
        if node_count > 10_000_000 {
            return Err("Implausible type tree".into());
        }
        let node_size = if version >= 19 { 32 } else { 24 };
        c.skip(node_count * node_size + strbuf)?;
        if version >= 21 {
            if is_ref {
                c.cstr()?; // class name
                c.cstr()?; // namespace
                c.cstr()?; // assembly
            } else {
                let deps = c.u32(be)? as usize;
                c.skip(deps * 4)?;
            }
        }
    }
    Ok(class_id)
}

pub(crate) fn read_serialized_file(bytes: &[u8]) -> R<(Vec<ObjectInfo>, u64, bool)> {
    let mut c = Cur::new(bytes);
    let _metadata_size = c.u32(true)?;
    let _file_size = c.u32(true)?;
    let version = c.u32(true)?;
    let mut data_offset = c.u32(true)? as u64;
    if !(17..=22).contains(&version) {
        return Err(format!("Unsupported SerializedFile version {version}"));
    }
    let endian = c.u8()?;
    c.skip(3)?;
    if version >= 22 {
        let _metadata_size = c.u32(true)?;
        let _file_size = c.u64(true)?;
        data_offset = c.u64(true)?;
        let _unknown = c.u64(true)?;
    }
    let be = endian != 0;

    let _unity_version = c.cstr()?;
    let _target_platform = c.u32(be)?;
    let enable_tree = if version >= 13 { c.u8()? != 0 } else { true };

    let type_count = c.u32(be)? as usize;
    if type_count > 100_000 {
        return Err("Implausible type count".into());
    }
    let mut class_ids = Vec::with_capacity(type_count);
    for _ in 0..type_count {
        class_ids.push(skip_type(&mut c, version, be, enable_tree, false)?);
    }

    let object_count = c.u32(be)? as usize;
    if object_count > 1_000_000 {
        return Err("Implausible object count".into());
    }
    let mut objects = Vec::with_capacity(object_count);
    for _ in 0..object_count {
        c.align(4);
        let path_id = c.i64(be)?;
        let byte_start = if version >= 22 { c.u64(be)? } else { c.u32(be)? as u64 };
        let byte_size = c.u32(be)?;
        let type_index = c.u32(be)? as usize;
        let class_id = *class_ids.get(type_index).ok_or("Bad type index")?;
        objects.push(ObjectInfo {
            path_id,
            class_id,
            byte_start,
            byte_size,
        });
    }
    Ok((objects, data_offset, be))
}

// ---------------------------------------------------------------------------
// Object payloads
// ---------------------------------------------------------------------------

fn looks_textual(s: &str) -> bool {
    let mut total = 0usize;
    let mut bad = 0usize;
    for c in s.chars().take(512) {
        total += 1;
        if c == '\u{FFFD}' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
            bad += 1;
        }
    }
    total > 0 && bad * 20 < total // < 5% control/replacement chars
}

pub(crate) fn parse_text_asset(data: &[u8], be: bool) -> R<(String, String)> {
    let mut c = Cur::new(data);
    let name = c.ustring(be)?;
    let len = c.u32(be)? as usize;
    let body = c.take(len)?;
    Ok((name, String::from_utf8_lossy(body).into_owned()))
}

/// Parse a MonoBehaviour as Aoharu.NoteData; Err = not a NoteData.
fn parse_note_data(data: &[u8], be: bool) -> R<(String, String)> {
    let mut c = Cur::new(data);
    c.skip(12)?; // m_GameObject PPtr
    c.u8()?; // m_Enabled
    c.align(4);
    c.skip(12)?; // m_Script PPtr
    let name = c.ustring(be)?;
    let _score_id = c.u32(be)?;
    let max_lane = c.i32(be)?;
    if !(1..=16).contains(&max_lane) {
        return Err("not notedata: max_lane".into());
    }
    let sound_name = c.ustring(be)?;
    let _bpm = c.i32(be)?;
    let _lpb = c.i32(be)?;
    let count = c.u32(be)? as usize;
    if count == 0 || count > 100_000 || count * 40 > data.len() {
        return Err("not notedata: note count".into());
    }

    #[derive(Serialize)]
    struct JNote {
        id: i32,
        num: i32,
        line: i32,
        time: f64,
        r#type: i32,
        parent_id: i32,
        child_id: i32,
        child_num: i32,
        child_line: i32,
        force_sync_group_id: i32,
    }
    let mut notes = Vec::with_capacity(count);
    for _ in 0..count {
        let id = c.i32(be)?;
        let num = c.i32(be)?;
        let line = c.i32(be)?;
        let time = c.f32(be)?;
        let ty = c.i32(be)?;
        let child_num = c.i32(be)?;
        let child_line = c.i32(be)?;
        let parent_id = c.i32(be)?;
        let child_id = c.i32(be)?;
        let force_sync = c.i32(be)?;
        if !(0..max_lane).contains(&line) || !time.is_finite() || time < 0.0 || !(0..=10).contains(&ty) {
            return Err("not notedata: field ranges".into());
        }
        notes.push(JNote {
            id,
            num,
            line,
            time: time as f64,
            r#type: ty,
            parent_id,
            child_id,
            child_num,
            child_line,
            force_sync_group_id: force_sync,
        });
    }
    let max_combo = c.i32(be).unwrap_or(0);

    let json = serde_json::json!({
        "max_lane": max_lane,
        "sound_name": sound_name,
        "max_combo_count": max_combo,
        "notes": notes,
    });
    Ok((name, serde_json::to_string(&json).map_err(|e| e.to_string())?))
}

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

pub fn extract_charts(bytes: &[u8]) -> R<Vec<ChartCandidate>> {
    let files = read_unityfs(bytes)?;
    let mut out = Vec::new();
    for (path, content) in files {
        if path.ends_with(".resS") || path.ends_with(".resource") {
            continue;
        }
        let Ok((objects, data_offset, be)) = read_serialized_file(&content) else {
            continue;
        };
        for obj in objects {
            let start = data_offset.saturating_add(obj.byte_start) as usize;
            let end = start.saturating_add(obj.byte_size as usize);
            if end > content.len() {
                continue;
            }
            let data = &content[start..end];
            match obj.class_id {
                49 => {
                    if let Ok((name, text)) = parse_text_asset(data, be) {
                        if looks_textual(&text) {
                            out.push(ChartCandidate {
                                name,
                                kind: "text".into(),
                                content: text,
                            });
                        }
                    }
                }
                114 => {
                    if let Ok((name, json)) = parse_note_data(data, be) {
                        out.push(ChartCandidate {
                            name,
                            kind: "notedata".into(),
                            content: json,
                        });
                    }
                }
                _ => {}
            }
        }
    }
    if out.is_empty() {
        return Err("No chart-like assets found in this bundle".into());
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Binary-body command: payload = raw bundle bytes.
#[tauri::command]
pub fn bundle_extract_charts(
    request: tauri::ipc::Request<'_>,
) -> Result<Vec<ChartCandidate>, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected a binary payload".into());
    };
    extract_charts(bytes)
}

#[cfg(test)]
mod tests {
    /// Temporary investigation helper:
    /// CHARTER_INVESTIGATE=/path/bundle CHARTER_DUMP_DIR=/tmp cargo test investigate -- --nocapture
    #[test]
    fn investigate() {
        let Ok(path) = std::env::var("CHARTER_INVESTIGATE") else {
            return;
        };
        let dump = std::env::var("CHARTER_DUMP_DIR").ok();
        let bytes = std::fs::read(path).unwrap();
        let files = super::read_unityfs(&bytes).unwrap();
        for (p, content) in files {
            println!("node {} ({} bytes)", p, content.len());
            if p.ends_with(".resS") {
                if let Some(d) = &dump {
                    std::fs::write(format!("{d}/resS.bin"), &content).unwrap();
                }
                continue;
            }
            let Ok((objs, off, be)) = super::read_serialized_file(&content) else {
                println!("  (not a serialized file)");
                continue;
            };
            for o in objs {
                let start = off as usize + o.byte_start as usize;
                let data = &content[start..start + o.byte_size as usize];
                println!("  class {} size {}", o.class_id, o.byte_size);
                if o.class_id == 49 {
                    let mut c = super::Cur::new(data);
                    if let (Ok(name), Ok(len)) = (c.ustring(be), c.u32(be)) {
                        println!("    TextAsset '{}' body {} bytes", name, len);
                        if let (Some(d), Ok(body)) = (&dump, c.take(len as usize)) {
                            std::fs::write(format!("{d}/{name}.bin"), body).unwrap();
                        }
                    }
                } else if o.class_id == 28 || o.class_id == 142 {
                    println!("    head: {:02x?}", &data[..data.len().min(120)]);
                    if let Some(d) = &dump {
                        std::fs::write(format!("{d}/class{}_{}.bin", o.class_id, o.byte_start), data)
                            .unwrap();
                    }
                }
            }
        }
    }

    /// Run manually: CHARTER_TEST_BUNDLE=/path/to/bundle cargo test bundle -- --nocapture
    #[test]
    fn extract_from_env_bundle() {
        let Ok(path) = std::env::var("CHARTER_TEST_BUNDLE") else {
            return;
        };
        let bytes = std::fs::read(path).unwrap();
        let charts = super::extract_charts(&bytes).unwrap();
        if let Ok(dir) = std::env::var("CHARTER_TEST_DUMP_DIR") {
            for c in &charts {
                std::fs::write(format!("{dir}/{}.{}", c.name, c.kind), &c.content).unwrap();
            }
        }
        for c in &charts {
            println!(
                "{} [{}] {} bytes | head: {:?}",
                c.name,
                c.kind,
                c.content.len(),
                &c.content[..c.content.len().min(80)]
            );
        }
        assert!(!charts.is_empty());
    }
}
