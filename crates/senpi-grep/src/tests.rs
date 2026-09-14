use super::*;
use crate::cancel::Checkpoint;
use crate::walk::{order_candidates, Candidate};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const PREFIX: usize = 4 * 1024 * 1024;
static NEXT_CORPUS: AtomicUsize = AtomicUsize::new(0);

struct Corpus(PathBuf);

impl Corpus {
    fn new() -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/grep-test-corpora")
            .join(format!(
                "{}-{}",
                std::process::id(),
                NEXT_CORPUS.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }

    fn put(&self, path: &str, bytes: impl AsRef<[u8]>) {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn path(&self, path: &str) -> String {
        self.0.join(path).to_str().unwrap().to_owned()
    }

    fn options(&self) -> GrepOptions {
        GrepOptions {
            pattern: "needle".into(),
            paths: vec![self.path("")],
            cwd: self.path(""),
            ..GrepOptions::default()
        }
    }

    fn search(&self, options: &GrepOptions) -> GrepResult {
        search(options, &CancelToken::new(options.timeout_ms)).unwrap()
    }
}

impl Drop for Corpus {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn matching_lines(result: &GrepResult) -> Vec<u32> {
    result
        .matches
        .iter()
        .filter(|row| !row.is_context)
        .map(|row| row.line)
        .collect()
}

#[test]
fn abi_sentinel_matches_abi_version() {
    assert_eq!(senpi_grep_abi_sentinel(), NATIVE_GREP_ABI_VERSION);
}

#[test]
fn ordered_limit_ignores_walk_completion_order() {
    let c = Corpus::new();
    c.put("z.ts", "needle\n");
    c.put("nested/a.ts", "needle\n");
    c.put("a.ts", "needle\n");
    // Exercise the actual ordering seam with a deliberately reversed visitor
    // completion sequence, not an assumption about OS/thread scheduling.
    let mut candidates: Vec<_> = ["z.ts", "nested/a.ts", "a.ts"]
        .into_iter()
        .map(|name| Candidate {
            path: c.0.join(name),
            display: name.into(),
        })
        .collect();
    order_candidates(&mut candidates);
    assert_eq!(
        candidates[0].display, "a.ts",
        "completion order must not admit z.ts first"
    );
    let mut o = c.options();
    o.paths = vec![c.path("z.ts"), c.path("nested"), c.path("")];
    o.max_count = Some(1);
    let r = c.search(&o);
    assert_eq!(r.matches.len(), 1);
    assert_eq!(r.matches[0].path, "a.ts");
    assert!(r.limit_reached);
    o.max_count = None;
    let r = c.search(&o);
    assert_eq!(r.counts.files, 3, "overlapping roots must be deduplicated");
}

#[test]
fn oversized_lexical_first_wins() {
    let c = Corpus::new();
    let mut large = vec![b'x'; PREFIX + 100];
    large[..7].copy_from_slice(b"needle\n");
    c.put("a-large.txt", large);
    c.put("z-small.txt", "needle\n");
    let mut o = c.options();
    o.max_count = Some(1);
    let r = c.search(&o);
    assert_eq!(r.matches[0].path, "a-large.txt", "large files cannot be deferred");
    assert_eq!(r.prefix_searched, 1);
    assert!(r.limit_reached);
}

#[test]
fn exact_cap_is_not_overflow() {
    let c = Corpus::new();
    c.put("a.ts", "needle\nneedle\n");
    let mut o = c.options();
    o.max_count = Some(2);
    o.max_count_per_file = Some(2);
    let r = c.search(&o);
    assert!(!r.limit_reached, "exact global cap is not overflow");
    assert!(!r.per_file_limit_reached, "exact per-file cap is not overflow");
    assert!(r.counts.exact);
    c.put("a.ts", "needle\nneedle\nneedle\n");
    let r = c.search(&o);
    assert_eq!(r.counts.matches, Some(2));
    assert!(r.per_file_limit_reached);
    assert!(!r.counts.exact);
    o.max_count_per_file = None;
    assert!(c.search(&o).limit_reached);
    o.mode = Some(GrepMode::Files);
    o.max_count = Some(1);
    assert!(!c.search(&o).limit_reached);
    c.put("z.ts", "needle\n");
    assert!(c.search(&o).limit_reached);
    o.max_count = Some(0);
    let r = c.search(&o);
    assert_eq!(r.counts.files, 0);
    assert!(r.limit_reached);
}

#[test]
fn context_union_preserves_match_rows() {
    let c = Corpus::new();
    c.put("a.ts", "before\nneedle\nbetween\nneedle\nafter\nfar\nneedle\n");
    let mut o = c.options();
    o.max_count_per_file = Some(2);
    o.context_before = Some(2);
    o.context_after = Some(2);
    let r = c.search(&o);
    assert_eq!(
        matching_lines(&r),
        vec![2, 4],
        "context cannot consume match budget"
    );
    assert_eq!(
        r.matches.iter().map(|r| r.line).collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5, 6]
    );
    assert_eq!(r.counts.matches, Some(2));
    assert!(r.per_file_limit_reached);
    assert!(r
        .matches
        .iter()
        .filter(|r| r.is_context)
        .all(|r| r.column.is_none()));
    // A match that would otherwise be context remains a match, never a duplicate.
    o.max_count_per_file = None;
    o.max_count = Some(2);
    let r = c.search(&o);
    assert_eq!(matching_lines(&r), vec![2, 4]);
    assert_eq!(
        r.matches.iter().map(|r| r.line).collect::<Vec<_>>(),
        vec![1, 2, 3, 4, 5, 6]
    );
}

#[test]
fn multiline_counts_physical_lines() {
    let c = Corpus::new();
    c.put("a.ts", "lead\nstart start\nend\nstart\nend\n");
    let mut o = c.options();
    o.pattern = "start[^\\n]*\\nend".into();
    o.multiline = Some(true);
    let r = c.search(&o);
    assert_eq!(
        r.counts.matches,
        Some(4),
        "match unit is physical lines, not regex occurrences"
    );
    assert_eq!(matching_lines(&r), vec![2, 3, 4, 5]);
    o.mode = Some(GrepMode::Count);
    assert_eq!(c.search(&o).file_counts[0].count, Some(4));
    o.max_count_per_file = Some(3);
    let r = c.search(&o);
    assert_eq!(r.file_counts[0].count, Some(3));
    assert!(r.file_counts[0].limit_reached);
}

#[test]
fn utf8_columns_whitespace_and_truncation() {
    let c = Corpus::new();
    c.put(
        "unicode.ts",
        format!("{}needle  \r\n\tneedle  \r\n", "界".repeat(600)),
    );
    let mut o = c.options();
    o.max_columns = Some(500);
    let r = c.search(&o);
    assert_eq!(r.matches[0].column, Some(1801), "columns are 1-based UTF-8 bytes");
    assert_eq!(r.matches[0].text, format!("{}...", "界".repeat(500)));
    assert!(r.matches[0].truncated);
    assert_eq!(
        r.matches[1].text, "\tneedle  ",
        "only line terminators may be stripped"
    );
    assert_eq!(r.matches[1].column, Some(2));
    assert!(!r.matches[1].truncated);
}

#[test]
fn prefix_boundary_and_binary_all_modes() {
    let c = Corpus::new();
    c.put("bin.dat", b"needle\n\0needle\n");
    let mut late = b"needle\n".to_vec();
    late.extend(vec![b'a'; 70_000]);
    late.extend(b"\n\0\nneedle\n");
    c.put("late-nul.bin", late);
    let mut large = vec![b'x'; 5 * 1024 * 1024];
    large[100..107].copy_from_slice(b"needle\n");
    large[4_500_000] = 0;
    large[PREFIX + 100..PREFIX + 107].copy_from_slice(b"needle\n");
    c.put("big-late-nul.txt", &large);
    // A NUL in the dropped, incomplete line is still in the inspected window.
    large[1000] = 0;
    c.put("prefix-nul.txt", &large);
    c.put("unsearchable.txt", vec![b'x'; PREFIX + 1]);
    let mut boundary = vec![b'x'; PREFIX + 100];
    boundary[..2].copy_from_slice(b"x\n");
    boundary[PREFIX - 6..PREFIX].copy_from_slice(b"needle");
    c.put("boundary.txt", boundary);
    for mode in [GrepMode::Content, GrepMode::Count, GrepMode::Files] {
        let mut o = c.options();
        o.mode = Some(mode);
        o.paths = vec![c.path("bin.dat"), c.path("late-nul.bin")];
        let r = c.search(&o);
        assert_eq!(
            r.skipped_binary, 2,
            "both early and late NULs skip entire files in {mode:?}"
        );
        assert!(r.matches.is_empty());
        assert!(r.file_counts.is_empty());
        assert_eq!(r.counts.files, 0);
        o.paths = vec![c.path("big-late-nul.txt")];
        let r = c.search(&o);
        assert_eq!(r.counts.files, 1);
        assert_eq!(r.prefix_searched, 1);
        assert_eq!(r.skipped_binary, 0);
        assert_eq!(
            r.counts.matches,
            if mode == GrepMode::Files { None } else { Some(1) }
        );
        o.paths = vec![
            c.path("prefix-nul.txt"),
            c.path("unsearchable.txt"),
            c.path("boundary.txt"),
        ];
        let r = c.search(&o);
        assert_eq!(
            r.skipped_binary, 1,
            "binary scan must precede dropping incomplete tail"
        );
        assert_eq!(r.skipped_oversized, 1);
        assert_eq!(r.prefix_searched, 1);
        assert_eq!(r.counts.files, 0, "incomplete boundary line must not match");
    }
}

#[test]
fn selector_filters_before_cap() {
    let c = Corpus::new();
    c.put("a.ts", "needle\nneedle\nneedle\nneedle\nneedle\n");
    let mut o = c.options();
    o.paths = vec![c.path("a.ts")];
    o.line_start = Some(3);
    o.line_end = Some(4);
    o.max_count_per_file = Some(1);
    o.max_count = Some(1);
    o.context_before = Some(5);
    o.context_after = Some(5);
    let r = c.search(&o);
    assert_eq!(
        matching_lines(&r),
        vec![3],
        "range filtering must precede either cap"
    );
    assert!(r.matches.iter().all(|r| (3..=4).contains(&r.line)));
    assert!(r.per_file_limit_reached);
    o.max_count_per_file = Some(2);
    o.max_count = Some(2);
    let r = c.search(&o);
    assert_eq!(matching_lines(&r), vec![3, 4]);
    assert!(
        r.counts.exact,
        "matches outside the selector cannot cause overflow"
    );
}

#[test]
fn timeout_no_match_scan_and_abort() {
    let c = Corpus::new();
    c.put("a.ts", "no match here\n".repeat(20_000));
    let o = c.options();
    for phase in [
        Checkpoint::Walk,
        Checkpoint::BeforeRead,
        Checkpoint::Read,
        Checkpoint::Scan,
    ] {
        let start = Instant::now();
        let seen = Arc::new(AtomicBool::new(false));
        let mark = seen.clone();
        let cancel = CancelToken::with_clock(start + Duration::from_secs(1), move |point| {
            if point == phase {
                mark.store(true, Ordering::Relaxed);
            }
            if mark.load(Ordering::Relaxed) {
                start + Duration::from_secs(2)
            } else {
                start
            }
        });
        let r = search(&o, &cancel).unwrap();
        assert!(
            seen.load(Ordering::Relaxed),
            "missing {phase:?} checkpoint on no-match scan"
        );
        assert!(r.timed_out, "timeout must be partial at {phase:?}");
        assert!(!r.counts.exact);
        assert!(r.matches.is_empty());
        assert!(r.warnings.iter().any(|w| w.code == "TIMEOUT"));
    }
    c.put("a.ts", "needle\nneedle\n");
    let start = Instant::now();
    let cancel = CancelToken::with_clock(start + Duration::from_secs(1), move |point| {
        if point == Checkpoint::Sink {
            start + Duration::from_secs(2)
        } else {
            start
        }
    });
    assert!(search(&o, &cancel).unwrap().timed_out);
    let cancel = CancelToken::new(None);
    cancel.aborted.store(true, Ordering::Release);
    assert!(matches!(search(&o, &cancel), Err(GrepError::Aborted)));
    // Abort while scanning, not just before entry; no event-loop or sleeps.
    let aborted = Arc::new(AtomicBool::new(false));
    let mark = aborted.clone();
    let mut cancel = CancelToken::with_clock(start + Duration::from_secs(1), move |point| {
        if point == Checkpoint::Scan {
            mark.store(true, Ordering::Release);
        }
        start
    });
    cancel.aborted = aborted;
    assert!(matches!(search(&o, &cancel), Err(GrepError::Aborted)));
}

#[test]
fn gitignore_hidden_type_glob_parity() {
    for git in [true, false] {
        let c = Corpus::new();
        c.put("src/a.ts", "needle\r\nneedle\r\nneedle\r\n");
        c.put("src/z.ts", "needle\n");
        c.put("src/nested/deep/b.ts", "needle\n");
        c.put(".hidden/h.ts", "needle\n");
        c.put("ignored/i.ts", "needle\n");
        c.put("scratch/s.ts", "needle\n");
        c.put("notes.txt", "needle\n");
        c.put(".gitignore", "ignored/\n");
        c.put(".ignore", "scratch/\n");
        if git {
            assert!(std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(&c.0)
                .status()
                .unwrap()
                .success());
        }
        c.put(".git/private.ts", "needle\n");
        #[cfg(unix)]
        std::os::unix::fs::symlink(".", c.0.join("loop")).unwrap();
        let mut o = c.options();
        o.r#type = Some("ts".into());
        o.mode = Some(GrepMode::Files);
        let r = c.search(&o);
        assert_eq!(
            r.file_counts.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec![".hidden/h.ts", "src/a.ts", "src/nested/deep/b.ts", "src/z.ts"],
            "git={git}"
        );
        o.hidden = Some(false);
        assert_eq!(c.search(&o).counts.files, 3);
        o.gitignore = Some(false);
        assert_eq!(c.search(&o).counts.files, 5);
        o.hidden = Some(true);
        o.glob = Some(vec!["!src/z.ts".into(), "*.ts".into(), "src/z.ts".into()]);
        let r = c.search(&o);
        assert_eq!(r.counts.files, 5, "negations win even over later positive globs");
        assert!(r
            .file_counts
            .iter()
            .all(|f| f.path != "src/z.ts" && !f.path.starts_with(".git/")));
        o.gitignore = Some(true);
        o.paths = vec![c.path("ignored/i.ts")];
        assert_eq!(c.search(&o).counts.files, 1, "explicit files bypass ignores");
    }
}

#[test]
fn unsupported_regex_is_typed_error() {
    let c = Corpus::new();
    c.put("a.ts", "ab a{ (?<=a)b\n");
    let mut o = c.options();
    for pattern in ["(?<=a)b", "a(?=b)", r"(a)\1", r"\Gabc"] {
        o.pattern = pattern.into();
        assert!(
            matches!(
                search(&o, &CancelToken::new(None)),
                Err(GrepError::UnsupportedRegex(_))
            ),
            "unsupported pattern: {pattern}"
        );
    }
    for pattern in ["a{", "[", r"\q", "(abc"] {
        o.pattern = pattern.into();
        assert!(
            matches!(
                search(&o, &CancelToken::new(None)),
                Err(GrepError::InvalidPattern(_))
            ),
            "invalid pattern: {pattern}"
        );
    }
    o.pattern = "(?<=a)b".into();
    o.literal = Some(true);
    let r = c.search(&o);
    assert_eq!(r.counts.matches, Some(1));
    assert_eq!(r.effective_pattern, o.pattern);
    assert_eq!(r.pattern_kind, "literal");
    assert_eq!(r.regex_engine, "rust");
    o.pcre2 = Some(true);
    assert!(matches!(
        search(&o, &CancelToken::new(None)),
        Err(GrepError::UnsupportedRegex(_))
    ));
}

#[test]
fn column_only_on_first_line_of_multiline_match() {
    let c = Corpus::new();
    c.put("a.ts", "before\nxx start\nend\nafter\nstart\nend\n");
    let mut o = c.options();
    o.pattern = "start\\nend".into();
    o.multiline = Some(true);
    o.context_before = Some(1);
    o.context_after = Some(1);
    let r = c.search(&o);
    assert_eq!(
        r.matches.iter().map(|r| (r.line, r.column)).collect::<Vec<_>>(),
        vec![
            (1, None),
            (2, Some(4)),
            (3, None),
            (4, None),
            (5, Some(1)),
            (6, None)
        ],
        "only the first physical line of each submatch has a column"
    );
}

#[test]
fn lossy_utf8_text() {
    let c = Corpus::new();
    c.put("latin1.txt", b"\xe9 needle  \n");
    let r = c.search(&c.options());
    assert_eq!(r.matches.len(), 1, "non-UTF-8 is text, not binary");
    assert_eq!(r.matches[0].text, "\u{fffd} needle  ");
    assert_eq!(r.matches[0].column, Some(3));
    assert_eq!(r.skipped_binary, 0);
}

#[test]
fn missing_roots_and_invalid_filters_are_typed() {
    let c = Corpus::new();
    c.put("a.ts", "needle\n");
    let mut o = c.options();
    o.paths = vec![c.path("missing"), c.path("a.ts")];
    assert_eq!(c.search(&o).missing_paths, vec![c.path("missing")]);
    o.paths = vec![c.path("missing")];
    assert!(matches!(
        search(&o, &CancelToken::new(None)),
        Err(GrepError::PathNotFound(_))
    ));
    o.paths = vec![c.path("a.ts")];
    o.glob = Some(vec!["[".into()]);
    assert!(matches!(
        search(&o, &CancelToken::new(None)),
        Err(GrepError::InvalidGlob(_))
    ));
    o.glob = None;
    o.r#type = Some("not-a-real-type".into());
    assert!(matches!(
        search(&o, &CancelToken::new(None)),
        Err(GrepError::UnknownType(_))
    ));
}

#[test]
fn anchor_columns_use_the_searchers_line_scope() {
    let c = Corpus::new();
    c.put("a.ts", "other\nneedle\nneedle\n");
    let mut o = c.options();
    o.pattern = "^needle$".into();
    for multiline in [false, true] {
        o.multiline = Some(multiline);
        let r = c.search(&o);
        assert_eq!(
            r.matches.iter().map(|r| r.column).collect::<Vec<_>>(),
            vec![Some(1), Some(1)],
            "anchored columns must agree with the searcher's scope; multiline={multiline}"
        );
    }
    o.pattern = r"\Aother\nneedle".into();
    let r = c.search(&o);
    assert_eq!(
        r.matches.iter().map(|r| r.column).collect::<Vec<_>>(),
        vec![Some(1), None]
    );
}

#[test]
fn trailing_carriage_return_without_lf_is_text() {
    let c = Corpus::new();
    c.put("a.ts", b"needle\r");
    assert_eq!(c.search(&c.options()).matches[0].text, "needle\r");
}

#[test]
fn directory_globs_apply_to_descendants() {
    let c = Corpus::new();
    c.put("src/a.ts", "needle\n");
    c.put("src/nested/b.ts", "needle\n");
    let mut o = c.options();
    for exclude in ["!nested", "!src/nested", "!src/nested/"] {
        o.glob = Some(vec!["*.ts".into(), exclude.into()]);
        let r = c.search(&o);
        assert_eq!(r.counts.files, 1, "excluded directory: {exclude}");
        assert_eq!(r.matches[0].path, "src/a.ts");
    }
}

#[test]
fn timeout_keeps_only_completed_ordered_prefix() {
    let c = Corpus::new();
    c.put("a.ts", "needle\n");
    c.put("b.ts", "no match\n");
    c.put("z.ts", "needle\n");
    let start = Instant::now();
    let reads = AtomicUsize::new(0);
    let cancel = CancelToken::with_clock(start + Duration::from_secs(1), move |point| {
        if point == Checkpoint::BeforeRead && reads.fetch_add(1, Ordering::Relaxed) == 1 {
            start + Duration::from_secs(2)
        } else {
            start
        }
    });
    // Rayon itself owns this worker. Single-worker scheduling makes the second
    // read's injected deadline exact without sleeps or completion-order luck.
    let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
    let r = pool.install(|| search(&c.options(), &cancel)).unwrap();
    assert!(r.timed_out);
    assert_eq!(r.counts.files, 1);
    assert_eq!(r.matches[0].path, "a.ts");
    assert_eq!(r.files_searched, 1);
}

#[test]
fn chunk_boundary_count_files_and_regex_options() {
    let c = Corpus::new();
    for i in (0..260).rev() {
        c.put(&format!("{i:03}.ts"), "Needle\nneedle\n");
    }
    let mut o = c.options();
    o.ignore_case = Some(true);
    o.mode = Some(GrepMode::Count);
    o.max_count = Some(257);
    let r = c.search(&o);
    assert_eq!(r.file_counts.len(), 257, "count-mode cap is matching files");
    assert_eq!(r.file_counts.last().unwrap().path, "256.ts");
    assert_eq!(r.counts.matches, Some(514));
    assert!(r.limit_reached);
    o.mode = Some(GrepMode::Files);
    let r = c.search(&o);
    assert_eq!(r.file_counts.len(), 257);
    assert_eq!(r.counts.matches, None);
    assert!(r
        .file_counts
        .iter()
        .all(|f| f.count.is_none() && !f.limit_reached));
    o.mode = Some(GrepMode::Content);
    o.max_count = Some(513);
    let r = c.search(&o);
    assert_eq!(r.matches.len(), 513);
    assert_eq!(r.matches.last().unwrap().path, "256.ts");
    assert!(r.limit_reached);
    o.max_count = None;
    o.pattern = "^needle$".into();
    assert_eq!(c.search(&o).counts.matches, Some(520));
}
