use std::{
    fs,
    io::{self, Read},
    path::Path,
    process::ExitCode,
};

#[derive(Default)]
struct Chunk {
    context: Option<String>,
    old: Vec<String>,
    new: Vec<String>,
    eof: bool,
}
struct Hunk {
    kind: char,
    path: String,
    destination: Option<String>,
    contents: String,
    chunks: Vec<Chunk>,
}
fn check(hunks: &[Hunk]) -> Result<(), String> {
    if let Some(h) = hunks.last() {
        if h.kind == 'M'
            && (h.chunks.is_empty()
                || h.chunks
                    .last()
                    .is_some_and(|c| c.old.is_empty() && c.new.is_empty()))
        {
            return Err(format!("Update file hunk for path '{}' is empty", h.path));
        }
    }
    Ok(())
}
fn parse(text: &str) -> Result<Vec<Hunk>, String> {
    let mut lines: Vec<&str> = text
        .trim()
        .split('\n')
        .map(|s| s.strip_suffix('\r').unwrap_or(s))
        .collect();
    if lines.len() >= 4
        && ["<<EOF", "<<'EOF'", "<<\"EOF\""].contains(&lines[0])
        && lines.last().unwrap().ends_with("EOF")
    {
        lines = lines[1..lines.len() - 1].to_vec();
    }
    if lines.first().map(|s| s.trim()) != Some("*** Begin Patch") {
        return Err("The first line of the patch must be '*** Begin Patch'".into());
    }
    if lines.last().map(|s| s.trim()) != Some("*** End Patch") {
        return Err("The last line of the patch must be '*** End Patch'".into());
    }
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut ended = false;
    for (i, raw) in lines.iter().enumerate().skip(1) {
        let error = |s: String| format!("line {}: {s}", i + 1);
        if ended {
            if !raw.trim().is_empty() {
                return Err(error("Unexpected content after End Patch".into()));
            }
            continue;
        }
        let key = if hunks.last().is_some_and(|h| h.kind == 'M') {
            raw.trim_end()
        } else {
            raw.trim()
        };
        if key == "*** End Patch" {
            check(&hunks).map_err(error)?;
            ended = true;
            continue;
        }
        let header = [
            ("*** Add File: ", 'A'),
            ("*** Delete File: ", 'D'),
            ("*** Update File: ", 'M'),
        ]
        .into_iter()
        .find_map(|(p, k)| key.strip_prefix(p).map(|path| (k, path)));
        if let Some((kind, path)) = header {
            check(&hunks).map_err(error)?;
            hunks.push(Hunk {
                kind,
                path: path.into(),
                destination: None,
                contents: String::new(),
                chunks: Vec::new(),
            });
            continue;
        }
        let h = hunks
            .last_mut()
            .ok_or_else(|| error("Invalid hunk header".into()))?;
        if h.kind == 'A' {
            let line = raw
                .strip_prefix('+')
                .ok_or_else(|| error("Added lines must start with '+'".into()))?;
            h.contents.push_str(line);
            h.contents.push('\n');
            continue;
        }
        if h.kind == 'D' {
            return Err(error("Invalid hunk header".into()));
        }
        let line = raw.trim_end();
        if h.chunks.is_empty() && h.destination.is_none() {
            if let Some(path) = line.strip_prefix("*** Move to: ") {
                h.destination = Some(path.into());
                continue;
            }
        }
        if line == "@@" || line.starts_with("@@ ") {
            if h.chunks
                .last()
                .is_some_and(|c| c.old.is_empty() && c.new.is_empty())
            {
                return Err(error("Update hunk does not contain any lines".into()));
            }
            h.chunks.push(Chunk {
                context: line.strip_prefix("@@ ").map(String::from),
                ..Default::default()
            });
            continue;
        }
        if line == "*** End of File" {
            if let Some(c) = h.chunks.last_mut() {
                if c.old.is_empty() && c.new.is_empty() {
                    return Err(error("Update hunk does not contain any lines".into()));
                }
                c.eof = true;
            }
            continue;
        }
        if h.chunks.last().is_some_and(|c| c.eof) {
            if line.is_empty() {
                continue;
            }
            return Err(error(
                "Expected update hunk to start with a @@ context marker".into(),
            ));
        }
        if h.chunks.is_empty() {
            h.chunks.push(Chunk::default());
        }
        let c = h.chunks.last_mut().unwrap();
        if raw.is_empty() {
            c.old.push(String::new());
            c.new.push(String::new());
        } else if let Some(s) = raw.strip_prefix(' ') {
            c.old.push(s.into());
            c.new.push(s.into());
        } else if let Some(s) = raw.strip_prefix('+') {
            c.new.push(s.into());
        } else if let Some(s) = raw.strip_prefix('-') {
            c.old.push(s.into());
        } else {
            return Err(error(format!(
                "Unexpected line found in update hunk: '{raw}'"
            )));
        }
    }
    if !ended {
        return Err("Missing End Patch".into());
    }
    Ok(hunks)
}
// 依次使用原文、行尾空白、两端空白、Unicode 标点归一化匹配。
fn normalized(s: &str, mode: usize) -> String {
    match mode {
        0 => s.into(),
        1 => s.trim_end().into(),
        2 => s.trim().into(),
        _ => s
            .trim()
            .chars()
            .map(|c| match c {
                '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
                '\u{2018}'..='\u{201b}' => '\'',
                '\u{201c}'..='\u{201f}' => '"',
                '\u{00a0}' | '\u{2002}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}' => ' ',
                _ => c,
            })
            .collect(),
    }
}
fn seek(lines: &[String], pattern: &[String], start: usize, eof: bool) -> Option<usize> {
    if pattern.is_empty() {
        return Some(start);
    }
    if pattern.len() > lines.len() {
        return None;
    }
    let first = if eof {
        lines.len() - pattern.len()
    } else {
        start
    };
    for mode in 0..4 {
        for i in first..=lines.len() - pattern.len() {
            if pattern
                .iter()
                .enumerate()
                .all(|(j, p)| normalized(&lines[i + j], mode) == normalized(p, mode))
            {
                return Some(i);
            }
        }
    }
    None
}
fn update(original: &str, h: &Hunk) -> Result<String, String> {
    let mut lines: Vec<String> = original.split('\n').map(String::from).collect();
    if lines.last().is_some_and(|s| s.is_empty()) {
        lines.pop();
    }
    let mut replacements = Vec::new();
    let mut index = 0;
    for c in &h.chunks {
        if let Some(context) = c.context.as_ref().filter(|s| !s.is_empty()) {
            index = seek(&lines, &[context.clone()], index, false)
                .ok_or_else(|| format!("Failed to find context '{context}' in {}", h.path))?
                + 1;
        }
        if c.old.is_empty() {
            let pos = lines.len() - usize::from(lines.last().is_some_and(|s| s.is_empty()));
            replacements.push((pos, 0, c.new.clone()));
            continue;
        }
        let mut old = c.old.clone();
        let mut new = c.new.clone();
        let mut found = seek(&lines, &old, index, c.eof);
        if found.is_none() && old.last().is_some_and(|s| s.is_empty()) {
            old.pop();
            if new.last().is_some_and(|s| s.is_empty()) {
                new.pop();
            }
            found = seek(&lines, &old, index, c.eof);
        }
        let pos = found.ok_or_else(|| {
            format!(
                "Failed to find expected lines in {}:\n{}",
                h.path,
                c.old.join("\n")
            )
        })?;
        index = pos + old.len();
        replacements.push((pos, old.len(), new));
    }
    replacements.sort_by_key(|r| r.0);
    for (pos, count, new) in replacements.into_iter().rev() {
        lines.splice(pos..pos + count, new);
    }
    if !lines.last().is_some_and(|s| s.is_empty()) {
        lines.push(String::new());
    }
    Ok(lines.join("\n"))
}
fn write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, text).map_err(|e| e.to_string())
}
fn apply(text: &str) -> Result<(), String> {
    let hunks = parse(text)?;
    if hunks.is_empty() {
        return Err("No files were modified.".into());
    }
    let mut added = Vec::new();
    let mut modified = Vec::new();
    let mut deleted = Vec::new();
    for h in hunks {
        let path = Path::new(&h.path);
        match h.kind {
            'A' => {
                write(path, &h.contents)?;
                added.push(h.path);
            }
            'D' => {
                fs::remove_file(path).map_err(|e| e.to_string())?;
                deleted.push(h.path);
            }
            _ => {
                let original = fs::read_to_string(path)
                    .map_err(|e| format!("Failed to read file to update {}: {e}", h.path))?;
                let content = update(&original, &h)?;
                if let Some(destination) = &h.destination {
                    write(Path::new(destination), &content)?;
                    fs::remove_file(path).map_err(|e| e.to_string())?;
                } else {
                    write(path, &content)?;
                }
                modified.push(h.path);
            }
        }
    }
    for (kind, paths) in [('A', added), ('M', modified), ('D', deleted)] {
        for path in paths {
            println!("{kind} {path}");
        }
    }
    Ok(())
}
fn main() -> ExitCode {
    let mut text = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut text) {
        eprintln!("apply_patch: {e}; next: 检查 stdin 编码后重新提交补丁");
        return ExitCode::from(1);
    }
    if text.trim().is_empty() {
        eprintln!("Usage: apply_patch <<'PATCH'\n*** Begin Patch\n...\n*** End Patch\nPATCH");
        return ExitCode::from(2);
    }
    match apply(&text) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("apply_patch: {e}; next: 检查文件现状和补丁上下文后重新提交；此前文件操作可能已生效");
            ExitCode::from(1)
        }
    }
}
