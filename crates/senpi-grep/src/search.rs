use crate::cancel::{CancelToken, Checkpoint};
use crate::matcher::{self, CheckedMatcher};
use crate::walk::{self, Candidate};
use crate::{GrepError, GrepFileCount, GrepMatch, GrepMode, GrepOptions, GrepResult, GrepWarning};
use grep_matcher::Matcher;
use grep_regex::RegexMatcher;
use grep_searcher::{BinaryDetection, MmapChoice, Searcher, SearcherBuilder, Sink, SinkContext, SinkMatch};
use rayon::prelude::*;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read};
use std::time::Instant;

const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const READ_CHUNK: usize = 64 * 1024;
const SEARCH_CHUNK: usize = 256;

#[derive(Default)]
struct FileResult {
    rows: Vec<GrepMatch>,
    matching: u32,
    per_file_limit: bool,
    searched: bool,
    prefix: bool,
    skipped_oversized: bool,
    binary: bool,
    warning: Option<GrepWarning>,
}

fn display_text(bytes: &[u8], max_columns: Option<u32>) -> (String, bool) {
    let bytes = match bytes.strip_suffix(b"\n") {
        Some(line) => line.strip_suffix(b"\r").unwrap_or(line),
        None => bytes,
    };
    let text = String::from_utf8_lossy(bytes);
    if let Some(max) = max_columns {
        if let Some((boundary, _)) = text.char_indices().nth(max as usize) {
            return (format!("{}...", &text[..boundary]), true);
        }
    }
    (text.into_owned(), false)
}

fn in_context(line: u32, matched: &[u32], before: u32, after: u32) -> bool {
    let index = matched.partition_point(|&m| m <= line);
    (index > 0 && line - matched[index - 1] <= after)
        || (index < matched.len() && matched[index] - line <= before)
}

struct Collector<'a> {
    options: &'a GrepOptions,
    candidate: &'a Candidate,
    matcher: CheckedMatcher<'a>,
    rows: BTreeMap<u32, GrepMatch>,
    matched_lines: Vec<u32>,
    matching: u32,
    budget: u32,
    overflow: bool,
}

impl Collector<'_> {
    fn row(&self, line: u32, column: Option<u32>, bytes: &[u8], is_context: bool) -> GrepMatch {
        let (text, truncated) = display_text(bytes, self.options.max_columns);
        GrepMatch {
            path: self.candidate.display.clone(),
            line,
            column,
            text,
            is_context,
            truncated,
        }
    }

    fn context_end(&self) -> u32 {
        self.matched_lines
            .last()
            .copied()
            .unwrap_or(0)
            .saturating_add(self.options.context_after.unwrap_or(0))
    }
}

impl Sink for Collector<'_> {
    type Error = io::Error;

    fn matched(&mut self, searcher: &Searcher, mat: &SinkMatch<'_>) -> io::Result<bool> {
        self.matcher.cancel.check(Checkpoint::Sink)?;
        let lines: Vec<_> = mat.lines().collect();
        let mut starts = Vec::with_capacity(lines.len());
        let mut offset = mat.bytes_range_in_buffer().start;
        for bytes in &lines {
            starts.push(offset);
            offset += bytes.len();
        }
        let mut columns = vec![None; lines.len()];
        if self.options.mode() == GrepMode::Content {
            if searcher.multi_line_with_matcher(&self.matcher) {
                // Preserve the original buffer for multiline \A/\z anchors.
                self.matcher.find_iter_at(mat.buffer(), starts[0], |found| {
                    if found.start() >= offset {
                        return false;
                    }
                    let index = starts.partition_point(|&start| start <= found.start()) - 1;
                    columns[index].get_or_insert((found.start() - starts[index] + 1) as u32);
                    true
                })?;
            } else {
                // Line-oriented search removes its terminator before matching.
                // Reproduce that scope, including for ^/$ and \A/\z.
                let line = mat.bytes().strip_suffix(b"\n").unwrap_or(mat.bytes());
                columns[0] = self.matcher.find(line)?.map(|found| (found.start() + 1) as u32);
            }
        }
        for (index, bytes) in lines.into_iter().enumerate() {
            self.matcher.cancel.check(Checkpoint::Sink)?;
            let line = mat.line_number().unwrap() as u32 + index as u32;
            if !self.options.includes_line(line) {
                continue;
            }
            if self.matching == self.budget {
                self.overflow = true;
                // Finish the last admitted match's context window, classifying
                // later matches as omitted matches, never as context rows.
                if line > self.context_end() {
                    return Ok(false);
                }
                continue;
            }
            self.matching += 1;
            self.matched_lines.push(line);
            if self.options.mode() == GrepMode::Content {
                self.rows
                    .insert(line, self.row(line, columns[index], bytes, false));
            }
            if self.options.mode() == GrepMode::Files {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn context(&mut self, _: &Searcher, context: &SinkContext<'_>) -> io::Result<bool> {
        self.matcher.cancel.check(Checkpoint::Sink)?;
        let line = context.line_number().unwrap() as u32;
        if self.overflow && line > self.context_end() {
            return Ok(false);
        }
        if self.options.mode() == GrepMode::Content
            && self.options.includes_line(line)
            && (self.matching < self.budget || line <= self.context_end())
        {
            let row = self.row(line, None, context.bytes(), true);
            self.rows.entry(line).or_insert(row);
        }
        Ok(true)
    }
}

fn read_prefix(file: &mut File, cancel: &CancelToken) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; READ_CHUNK];
    while bytes.len() < MAX_FILE_BYTES {
        cancel.check(Checkpoint::Read)?;
        let capacity = buffer.len().min(MAX_FILE_BYTES - bytes.len());
        let n = file.read(&mut buffer[..capacity])?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..n]);
    }
    cancel.check(Checkpoint::Read)?;
    Ok(bytes)
}

fn search_file(
    candidate: &Candidate,
    options: &GrepOptions,
    regex: &RegexMatcher,
    cancel: &CancelToken,
) -> io::Result<FileResult> {
    cancel.check(Checkpoint::BeforeRead)?;
    let mut file = File::open(&candidate.path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::other("candidate is no longer a regular file"));
    }
    let oversized = metadata.len() > MAX_FILE_BYTES as u64;
    let mut bytes = read_prefix(&mut file, cancel)?;
    // Classify the ENTIRE inspected window, including any incomplete tail.
    // A late NUL must discard earlier matches in every output mode.
    if memchr::memchr(0, &bytes).is_some() {
        return Ok(FileResult {
            binary: true,
            ..FileResult::default()
        });
    }
    if oversized {
        match memchr::memrchr(b'\n', &bytes) {
            Some(last) => bytes.truncate(last + 1),
            None => {
                return Ok(FileResult {
                    skipped_oversized: true,
                    ..FileResult::default()
                })
            }
        }
    }
    let budget = if options.mode() == GrepMode::Files {
        1
    } else {
        let per_file = options.max_count_per_file.unwrap_or(u32::MAX);
        if options.mode() == GrepMode::Content {
            per_file.min(options.max_count.map_or(u32::MAX, |max| max.saturating_add(1)))
        } else {
            per_file
        }
    };
    let mut collector = Collector {
        options,
        candidate,
        matcher: CheckedMatcher { inner: regex, cancel },
        rows: BTreeMap::new(),
        matched_lines: Vec::new(),
        matching: 0,
        budget,
        overflow: false,
    };
    let content = options.mode() == GrepMode::Content;
    SearcherBuilder::new()
        .line_number(true)
        .before_context(if content {
            options.context_before.unwrap_or(0) as usize
        } else {
            0
        })
        .after_context(if content {
            options.context_after.unwrap_or(0) as usize
        } else {
            0
        })
        .multi_line(options.multiline.unwrap_or(false))
        .binary_detection(BinaryDetection::none())
        .memory_map(MmapChoice::never())
        .bom_sniffing(false)
        .build()
        .search_slice(CheckedMatcher { inner: regex, cancel }, &bytes, &mut collector)?;
    cancel.check(Checkpoint::Finish)?;
    collector.rows.retain(|&line, row| {
        !row.is_context
            || in_context(
                line,
                &collector.matched_lines,
                options.context_before.unwrap_or(0),
                options.context_after.unwrap_or(0),
            )
    });
    Ok(FileResult {
        rows: collector.rows.into_values().collect(),
        matching: collector.matching,
        per_file_limit: collector.overflow && options.max_count_per_file == Some(budget),
        searched: true,
        prefix: oversized,
        ..FileResult::default()
    })
}

fn search_one(
    candidate: &Candidate,
    options: &GrepOptions,
    regex: &RegexMatcher,
    cancel: &CancelToken,
) -> io::Result<FileResult> {
    match search_file(candidate, options, regex, cancel) {
        Ok(result) => Ok(result),
        Err(error) if cancel.is_aborted() || cancel.timed_out() => Err(error),
        Err(error) => Ok(FileResult {
            skipped_oversized: candidate
                .path
                .metadata()
                .is_ok_and(|m| m.len() > MAX_FILE_BYTES as u64),
            warning: Some(GrepWarning {
                path: Some(candidate.display.clone()),
                code: "IO_ERROR".into(),
                message: error.to_string(),
            }),
            ..FileResult::default()
        }),
    }
}

fn commit_file(result: &mut GrepResult, mut file: FileResult, candidate: &Candidate, options: &GrepOptions) {
    result.files_searched += u32::from(file.searched);
    result.prefix_searched += u32::from(file.prefix);
    result.skipped_oversized += u32::from(file.skipped_oversized);
    result.skipped_binary += u32::from(file.binary);
    if let Some(warning) = file.warning {
        result.warnings.push(warning);
    }
    result.per_file_limit_reached |= file.per_file_limit;
    if file.matching == 0 {
        return;
    }
    let content = options.mode() == GrepMode::Content;
    let used = if content {
        result.counts.matches.unwrap()
    } else {
        result.counts.files
    };
    let remaining = options.max_count.map_or(u32::MAX, |cap| cap.saturating_sub(used));
    let units = if content { file.matching } else { 1 };
    // The extra row/file proves overflow. Equality alone proves nothing.
    result.limit_reached = units > remaining;
    if remaining == 0 {
        return;
    }
    if content {
        let admitted = file.matching.min(remaining);
        let lines: Vec<_> = file
            .rows
            .iter()
            .filter(|row| !row.is_context)
            .take(admitted as usize)
            .map(|row| row.line)
            .collect();
        file.rows.retain(|row| {
            if row.is_context {
                in_context(
                    row.line,
                    &lines,
                    options.context_before.unwrap_or(0),
                    options.context_after.unwrap_or(0),
                )
            } else {
                lines.binary_search(&row.line).is_ok()
            }
        });
        result.matches.extend(file.rows);
        *result.counts.matches.as_mut().unwrap() += admitted;
    } else {
        let count = (options.mode() == GrepMode::Count).then_some(file.matching);
        result.file_counts.push(GrepFileCount {
            path: candidate.display.clone(),
            count,
            limit_reached: file.per_file_limit,
        });
        if let Some(total) = &mut result.counts.matches {
            *total += file.matching;
        }
    }
    result.counts.files += 1;
}

/// Synchronous Rust core. The N-API task runs this on its libuv worker; only
/// ignore and rayon create search workers. Results cross the commit boundary
/// in path order, never in worker completion order.
pub fn search(options: &GrepOptions, cancel: &CancelToken) -> Result<GrepResult, GrepError> {
    let start = Instant::now();
    if cancel.is_aborted() {
        return Err(GrepError::Aborted);
    }
    let regex = matcher::compile(options)?;
    let candidates = walk::collect(options, cancel)?;
    let mut result = GrepResult::empty(options);
    result.missing_paths = candidates.missing;
    result.warnings = candidates.warnings;
    result.timed_out = cancel.timed_out();
    'chunks: for chunk in candidates.files.chunks(SEARCH_CHUNK) {
        let files: Vec<_> = chunk
            .par_iter()
            .map(|candidate| search_one(candidate, options, &regex, cancel))
            .collect();
        for (candidate, file) in chunk.iter().zip(files) {
            match file {
                Ok(file) => commit_file(&mut result, file, candidate, options),
                Err(_) if cancel.is_aborted() => return Err(GrepError::Aborted),
                Err(_) if cancel.timed_out() => {
                    result.timed_out = true;
                    break 'chunks;
                }
                Err(error) => return Err(GrepError::EngineUnavailable(error.to_string())),
            }
            if result.limit_reached {
                break 'chunks;
            }
        }
    }
    if cancel.is_aborted() {
        return Err(GrepError::Aborted);
    }
    if result.timed_out {
        result.warnings.push(GrepWarning {
            path: None,
            code: "TIMEOUT".into(),
            message: "Search timed out; returning the completed ordered prefix".into(),
        });
    }
    result.counts.exact = !(result.limit_reached || result.per_file_limit_reached || result.timed_out);
    result.elapsed_ms = start.elapsed().as_millis() as f64;
    Ok(result)
}
