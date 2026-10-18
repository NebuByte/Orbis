//! Quick preview (Space on a result): the readers the page cannot do by itself. Images, PDFs, video
//! and sound are shown by the WebView straight from disk (asset protocol); this module reads text and
//! code, Word / Excel / PowerPoint files, and a folder's contents from the index.

use serde::Serialize;
use std::io::Read;

const TEXT_MAX: usize = 300 * 1024;

#[derive(Serialize)]
pub struct Text {
    pub text: String,
    pub truncated: bool,
}

/// plain text and code: the first 300 KB, UTF-8 or UTF-16, Arabic code page as a fallback
#[tauri::command]
pub async fn preview_text(path: String) -> Result<Text, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        f.by_ref().take(TEXT_MAX as u64 + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        let truncated = buf.len() > TEXT_MAX;
        buf.truncate(TEXT_MAX);
        let text = if buf.starts_with(&[0xFF, 0xFE]) || buf.starts_with(&[0xFE, 0xFF]) {
            let be = buf[0] == 0xFE;
            let units: Vec<u16> = buf[2..].chunks_exact(2).map(|c| if be { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) }).collect();
            String::from_utf16_lossy(&units)
        } else {
            String::from_utf8_lossy(buf.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&buf)).into_owned()
        };
        if text.chars().take(4000).filter(|c| *c == '\u{FFFD}' || (c.is_control() && !c.is_whitespace())).count() > 40 {
            return Err("This file is not text.".into());
        }
        Ok(Text { text, truncated })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Default)]
pub struct Office {
    /// "doc" (paragraphs), "sheet" (rows of cells) or "slides" (text per slide)
    pub kind: String,
    pub paras: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub slides: Vec<Vec<String>>,
}

fn decode(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#39;", "'").replace("&amp;", "&")
}
/// the text of every <tag>…</tag> (e.g. w:t, a:t, t) in order
fn texts(xml: &str, tag: &str) -> Vec<String> {
    let (open, close) = (format!("<{tag}"), format!("</{tag}>"));
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(i) = xml[at..].find(&open).map(|i| i + at) {
        let after = xml[i + open.len()..].chars().next().unwrap_or(' ');
        let Some(gt) = xml[i..].find('>').map(|g| g + i) else { break };
        if (after == '>' || after == ' ') && !xml[..gt].ends_with('/') {
            if let Some(end) = xml[gt..].find(&close).map(|e| e + gt) {
                out.push(decode(&xml[gt + 1..end]));
                at = end;
                continue;
            }
        }
        at = gt;
    }
    out
}
fn part(z: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut f = z.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}
/// column letters of a cell reference ("BC12" -> 54)
fn col(r: &str) -> usize {
    r.chars().take_while(|c| c.is_ascii_alphabetic()).fold(0, |n, c| n * 26 + (c.to_ascii_uppercase() as usize - 'A' as usize + 1))
}

/// Word, Excel and PowerPoint (the modern formats): paragraphs, the first sheet, or slide texts
#[tauri::command]
pub async fn preview_office(path: String) -> Result<Office, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
        let f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut z = zip::ZipArchive::new(f).map_err(|_| "This file could not be opened.".to_string())?;
        let mut o = Office::default();
        match ext.as_str() {
            "docx" => {
                o.kind = "doc".into();
                let xml = part(&mut z, "word/document.xml").ok_or("No text in this document.")?;
                for p in xml.split("</w:p>").take(1500) {
                    let t = texts(p, "w:t").concat();
                    if !t.trim().is_empty() {
                        o.paras.push(t);
                    }
                }
            }
            "xlsx" | "xlsm" => {
                o.kind = "sheet".into();
                let shared: Vec<String> = part(&mut z, "xl/sharedStrings.xml")
                    .map(|x| x.split("</si>").map(|si| texts(si, "t").concat()).collect())
                    .unwrap_or_default();
                let sheet = part(&mut z, "xl/worksheets/sheet1.xml").ok_or("No sheet in this workbook.")?;
                for row in sheet.split("</row>").take(200) {
                    let mut cells: Vec<String> = Vec::new();
                    for c in row.split("<c ").skip(1) {
                        let head = &c[..c.find('>').unwrap_or(0)];
                        let r = head.split("r=\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or("");
                        let shared_str = head.contains("t=\"s\"");
                        let v = texts(c, "v").into_iter().next().or_else(|| texts(c, "t").into_iter().next()).unwrap_or_default();
                        let v = if shared_str { v.parse::<usize>().ok().and_then(|k| shared.get(k).cloned()).unwrap_or_default() } else { v };
                        let k = col(r).max(1) - 1;
                        if k < 30 {
                            if cells.len() <= k {
                                cells.resize(k + 1, String::new());
                            }
                            cells[k] = v;
                        }
                    }
                    if cells.iter().any(|c| !c.is_empty()) {
                        o.rows.push(cells);
                    }
                }
            }
            "pptx" => {
                o.kind = "slides".into();
                let mut names: Vec<(usize, String)> = (0..z.len())
                    .filter_map(|i| z.by_index(i).ok().map(|f| f.name().to_string()))
                    .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
                    .map(|n| (n.trim_start_matches("ppt/slides/slide").trim_end_matches(".xml").parse().unwrap_or(0), n))
                    .collect();
                names.sort();
                for (_, n) in names.into_iter().take(80) {
                    if let Some(x) = part(&mut z, &n) {
                        o.slides.push(x.split("</a:p>").map(|p| texts(p, "a:t").concat()).filter(|t| !t.trim().is_empty()).collect());
                    }
                }
            }
            _ => return Err("No preview for this type.".into()),
        }
        Ok(o)
    })
    .await
    .map_err(|e| e.to_string())?
}
